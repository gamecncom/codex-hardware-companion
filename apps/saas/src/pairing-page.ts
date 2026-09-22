/** Render the phone side of the QR pairing flow. No credential is placed in the URL. */
export function renderPairingPage(devicePairingId: string, challenge: string): string {
  const safeJson = (value: string) => JSON.stringify(value).replace(/</g, '\\u003c');
  const id = safeJson(devicePairingId);
  const ch = safeJson(challenge);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hardware Companion 配对</title>
<h1>连接电脑</h1><p>输入邮箱验证码和电脑显示的 6 位配对码。确认后，请回电脑端按键完成绑定。</p>
<form id="pair-form"><label>邮箱 <input id="email" type="email" autocomplete="email"></label><button id="send-code" type="button">发送验证码</button>
<label>验证码 <input id="email-code" inputmode="numeric" autocomplete="one-time-code"></label>
<label>电脑 6 位码 <input id="computer-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"></label>
<label><input id="confirm" type="checkbox"> 我确认要连接这台电脑</label><button id="claim" type="button">确认配对</button></form><pre id="message" role="status"></pre>
<script>(()=>{const q=s=>document.querySelector(s),id=${id},challenge=${ch},email=q('#email'),emailCode=q('#email-code'),computerCode=q('#computer-code'),confirm=q('#confirm'),message=q('#message');let session;
q('#send-code').addEventListener('click',async()=>{if(!email.value.trim()){message.textContent='请输入邮箱';return}try{const r=await fetch('/v1/auth/email/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:email.value.trim()})});message.textContent=r.ok?'验证码已发送':'验证码发送失败'}catch(_){message.textContent='验证码发送失败'}});
q('#claim').addEventListener('click',async()=>{if(!confirm.checked){message.textContent='请先勾选确认';return}if(!emailCode.value.trim()||!/^\\d{6}$/.test(computerCode.value.trim())){message.textContent='请输入验证码和 6 位电脑码';return}try{if(!session){const verified=await fetch('/v1/auth/email/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:email.value.trim(),code:emailCode.value.trim()})});const v=await verified.json();session=v.data&&v.data.sessionToken;if(!session){message.textContent='验证码无效';return}}const claimed=await fetch('/v1/device-pairings/'+encodeURIComponent(id)+'/claim',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+session},body:JSON.stringify({code:computerCode.value.trim(),challenge})});message.textContent=claimed.ok?'已提交，请回设备按键确认':'配对失败，请检查电脑 6 位码'}catch(_){message.textContent='配对失败，请稍后重试'}});})();</script>`;
}
