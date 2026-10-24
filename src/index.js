const SITE_URL = "https://farflight.cc";
const GATEWAY = "https://openapi.alipay.com/gateway.do";
const RESEND_FROM = "DartVault <onboarding@resend.dev>";

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } });
}

function b64ToBuf(b64) {
  const s = atob(b64);
  const arr = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
  return arr;
}

function bufToB64(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function derLen(n) {
  if (n < 0x80) return [n];
  if (n < 0x100) return [0x81, n];
  return [0x82, (n >> 8) & 0xff, n & 0xff];
}

function pkcs1ToPkcs8(k) {
  const ver = [0x02, 0x01, 0x00];
  const alg = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04].concat(derLen(k.length), Array.from(k));
  const inner = ver.length + alg.length + octet.length;
  return new Uint8Array([0x30].concat(derLen(inner), ver, alg, octet));
}

function stripPem(key) {
  return String(key || "").replace(/-----(BEGIN|END)[^-]*-----/g, "").replace(/\s+/g, "");
}

async function importPrivateKey(env) {
  const raw = String(env.ALIPAY_PRIVATE_KEY || "");
  const isPkcs1 = raw.indexOf("BEGIN RSA PRIVATE KEY") !== -1;
  const der = b64ToBuf(stripPem(raw));
  const pkcs8 = isPkcs1 ? pkcs1ToPkcs8(der) : der;
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

async function importPublicKey(env) {
  const der = b64ToBuf(stripPem(env.ALIPAY_PUBLIC_KEY));
  return crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

async function signData(env, content) {
  const key = await importPrivateKey(env);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(content));
  return bufToB64(sig);
}

async function verifyData(env, content, signB64) {
  try {
    const key = await importPublicKey(env);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64ToBuf(signB64), new TextEncoder().encode(content));
  } catch (e) {
    return false;
  }
}

function buildSignContent(params) {
  return Object.keys(params)
    .filter(function (k) { return k !== "sign" && k !== "sign_type" && params[k] !== "" && params[k] !== undefined && params[k] !== null; })
    .sort()
    .map(function (k) { return k + "=" + params[k]; })
    .join("&");
}

function beijingNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = function (n) { return String(n).padStart(2, "0"); };
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds());
}

function genOrderNo() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = function (n) { return String(n).padStart(2, "0"); };
  const rand = bufToB64(crypto.getRandomValues(new Uint8Array(9))).replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toUpperCase();
  return "DV" + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + rand;
}

function alipayConfigured(env) {
  return Boolean(env.ALIPAY_APP_ID && env.ALIPAY_PRIVATE_KEY && env.ALIPAY_PUBLIC_KEY);
}

async function signedParams(env, method, biz, extra) {
  const params = {
    app_id: env.ALIPAY_APP_ID,
    method: method,
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: beijingNow(),
    version: "1.0"
  };
  if (extra) Object.assign(params, extra);
  if (biz) params.biz_content = JSON.stringify(biz);
  params.sign = await signData(env, buildSignContent(params));
  return params;
}

async function handleCreateOrder(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!alipayConfigured(env)) return json({ error: "not_configured" }, 503);
  let data;
  try { data = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400); }
  const subject = String(data.subject || "").trim().slice(0, 100);
  const amount = String(data.amount || "").trim();
  const payerName = String(data.payerName || "").trim().slice(0, 50);
  const contact = String(data.contact || "").trim().slice(0, 100);
  if (!subject) return json({ error: "missing_subject" }, 400);
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(amount) || parseFloat(amount) < 0.01) return json({ error: "invalid_amount" }, 400);
  const outTradeNo = genOrderNo();
  const passback = encodeURIComponent(JSON.stringify({ payerName: payerName, contact: contact }));
  const params = await signedParams(env, "alipay.trade.page.pay", {
    out_trade_no: outTradeNo,
    total_amount: amount,
    subject: subject,
    product_code: "FAST_INSTANT_TRADE_PAY",
    passback_params: passback
  }, {
    notify_url: SITE_URL + "/api/alipay/notify",
    return_url: SITE_URL + "/pay-result.html"
  });
  return json({ orderNo: outTradeNo, action: GATEWAY + "?charset=utf-8", params: params });
}

async function handleNotify(request, env) {
  if (request.method !== "POST") return new Response("fail", { status: 405 });
  const params = {};
  new URLSearchParams(await request.text()).forEach(function (v, k) { params[k] = v; });
  const sign = params.sign || "";
  const content = buildSignContent(params);
  const verified = await verifyData(env, content, sign);
  if (!verified) return new Response("fail");
  if (params.app_id !== env.ALIPAY_APP_ID) return new Response("fail");
  if (params.trade_status === "TRADE_SUCCESS" || params.trade_status === "TRADE_FINISHED") {
    try {
      await sendMail(env, params);
    } catch (e) {
      console.error("send mail failed", e);
      return new Response("fail");
    }
  }
  return new Response("success");
}

async function handleStatus(request, env, url) {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  if (!alipayConfigured(env)) return json({ error: "not_configured" }, 503);
  const orderNo = url.searchParams.get("order_no") || "";
  if (!/^DV\d{8}[A-Z0-9]{6}$/.test(orderNo)) return json({ error: "bad_order" }, 400);
  const params = await signedParams(env, "alipay.trade.query", { out_trade_no: orderNo });
  const resp = await fetch(GATEWAY + "?charset=utf-8", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString()
  });
  let data;
  try { data = await resp.json(); } catch (e) { return json({ error: "gateway_error" }, 502); }
  const r = data.alipay_trade_query_response;
  if (!r) return json({ error: "gateway_error" }, 502);
  if (r.code === "10000") {
    return json({
      found: true,
      trade_status: r.trade_status,
      subject: r.subject,
      total_amount: r.total_amount,
      trade_no: r.trade_no,
      buyer_logon_id: r.buyer_logon_id || ""
    });
  }
  if (r.code === "40004") return json({ found: false, trade_status: "WAIT_BUYER_PAY" });
  return json({ error: r.sub_msg || r.msg || "gateway_error", code: r.code }, 502);
}

function esc(s) {
  return String(s === null || s === undefined ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function safePassback(p) {
  try { return JSON.parse(decodeURIComponent(p || "{}")); } catch (e) { return {}; }
}

async function sendMail(env, p) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY missing");
  const to = env.NOTIFY_EMAIL || "justin-zhao@qq.com";
  const pb = safePassback(p.passback_params);
  const rows = [
    ["订单号 Order No.", p.out_trade_no],
    ["支付宝交易号 Trade No.", p.trade_no],
    ["商品 Product", p.subject],
    ["金额 Amount (CNY)", p.total_amount],
    ["付款人(支付宝) Buyer", [p.buyer_logon_id, p.buyer_user_name].filter(Boolean).join(" / ")],
    ["付款人(客户自填) Payer", [pb.payerName, pb.contact].filter(Boolean).join(" / ")],
    ["支付时间 Paid At", p.gmt_payment || p.send_pay_date || ""],
    ["交易状态 Status", p.trade_status]
  ];
  const html = '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto"><h2 style="color:#0e1116;margin-bottom:4px">DartVault 新订单支付成功</h2><p style="color:#888;font-size:12px;margin-top:0">farflight.cc 支付回调自动通知</p><table style="width:100%;border-collapse:collapse">' +
    rows.map(function (r) {
      return '<tr><td style="padding:8px 12px;border:1px solid #ddd;background:#f6f7f9;width:170px;font-size:13px;color:#555">' + esc(r[0]) + '</td><td style="padding:8px 12px;border:1px solid #ddd;font-size:14px;color:#111">' + esc(r[1]) + '</td></tr>';
    }).join("") +
    '</table></div>';
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject: "【DartVault】支付成功 " + (p.total_amount || "") + " 元 · " + (p.out_trade_no || ""),
      html: html
    })
  });
  if (!res.ok) throw new Error("resend " + res.status + " " + (await res.text()));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/pay/create") return handleCreateOrder(request, env);
    if (url.pathname === "/api/alipay/notify") return handleNotify(request, env);
    if (url.pathname === "/api/pay/status") return handleStatus(request, env, url);
    return env.ASSETS.fetch(request);
  }
};
