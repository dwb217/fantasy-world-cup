// Vercel Edge Middleware — password-gates the whole site with a shared password.
// Reuses the same EDIT_PASSWORD env var used for saving edits. A correct login
// (handled by /api/login) sets an auth cookie; this checks it on every request.

export const config = {
  // Run on everything except the login endpoint and Vercel internals.
  matcher: ["/((?!api/login|_vercel|favicon.ico).*)"],
};

const COOKIE = "fwc_auth";
const SALT = "::fwc-site"; // public salt; security rests on the secret password

export default async function middleware(request) {
  const password = process.env.EDIT_PASSWORD;
  if (!password) return; // not configured → don't lock anyone out

  const expected = await sha256(password + SALT);
  const cookies = parseCookies(request.headers.get("cookie") || "");
  if (cookies[COOKIE] === expected) return; // authenticated → continue

  return new Response(loginHtml(), {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseCookies(header) {
  const out = {};
  header.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function loginHtml() {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fantasy World Cup — Sign in</title>
<style>
  :root{--bg:#0d1117;--panel:#161b22;--panel2:#1c232c;--border:#2a3340;--text:#e6edf3;--muted:#8b97a6;--accent:#2f81f7}
  *{box-sizing:border-box}html,body{margin:0;height:100%}
  body{background:linear-gradient(135deg,#14213d,#0d1117 60%);color:var(--text);
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    display:grid;place-items:center;min-height:100vh}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:14px;
    padding:32px 28px;width:min(360px,92vw);box-shadow:0 8px 30px rgba(0,0,0,.4);text-align:center}
  h1{margin:0 0 4px;font-size:1.5rem}p{margin:0 0 20px;color:var(--muted);font-size:.9rem}
  input{width:100%;background:var(--panel2);border:1px solid var(--border);color:var(--text);
    padding:11px 13px;border-radius:9px;font-size:1rem;margin-bottom:12px}
  input:focus{outline:none;border-color:var(--accent)}
  button{width:100%;background:var(--accent);border:none;color:#fff;padding:11px;border-radius:9px;
    font-size:1rem;font-weight:600;cursor:pointer}button:hover{filter:brightness(1.1)}
  .err{color:#f85149;font-size:.85rem;min-height:1.2em;margin-top:8px}
</style></head><body>
<form class="card" id="f">
  <h1>🏆 Fantasy World Cup</h1>
  <p>Enter the league password to continue.</p>
  <input type="password" id="pw" placeholder="Password" autocomplete="current-password" autofocus>
  <button type="submit">Sign in</button>
  <div class="err" id="e"></div>
</form>
<script>
  var f=document.getElementById('f'),pw=document.getElementById('pw'),e=document.getElementById('e');
  f.addEventListener('submit',async function(ev){
    ev.preventDefault();e.textContent='';
    try{
      var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({password:pw.value})});
      if(r.ok){location.reload();}
      else{e.textContent='Wrong password.';pw.value='';pw.focus();}
    }catch(err){e.textContent='Something went wrong. Try again.';}
  });
</script></body></html>`;
}
