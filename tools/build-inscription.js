// Builds the ⌈seal⌉ generator as one standalone HTML file, ready to inscribe on Bitcoin.
// The page renders any seal from its id (#42 or ?id=42), animated like the site, with no network access.
// It is the collection's parent inscription: its reveal tx also carries the crc-21 deploy OP_RETURN (docs/protocol.md).
// Usage: node tools/build-inscription.js inscription
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib');
const OUT=process.argv[2];if(!OUT)throw 'usage: node tools/build-inscription.js <outdir>';
const engine=fs.readFileSync(path.join(__dirname,'..','src','engine.js'),'utf8');
if(engine.includes('</script'))throw 'engine.js contains </script';

const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>⌈seal⌉</title>
<style>html,body{margin:0;height:100%;background:#000}canvas{display:block;width:100vmin;height:100vmin;margin:auto;image-rendering:pixelated}</style>
</head><body><canvas id="c" width="32" height="32"></canvas><script>
${engine}
;(()=>{const q=new URLSearchParams(location.search),{items}=buildCollection();
let id=parseInt(location.hash.slice(1)||q.get('id')||'1',10);if(!(id>=1&&id<=items.length))id=1;
const it=items[id-1],cv=document.getElementById('c'),ctx=cv.getContext('2d'),img=ctx.createImageData(S,S);
document.title='⌈seal⌉ #'+id;
function paint(t){const b=new Buf(),B=C(it.col.bgOf?it.col.bgOf(it.sp):it.col.bg);it.col.draw(b,it.sp,t,B);
  for(let i=0;i<S*S;i++){const c=b.p[i]||B;img.data[i*4]=c[0];img.data[i*4+1]=c[1];img.data[i*4+2]=c[2];img.data[i*4+3]=255}ctx.putImageData(img,0,0)}
let T=0,last=0;paint(T);
function loop(ts){if(ts-last>120){last=ts;paint(++T)}requestAnimationFrame(loop)}requestAnimationFrame(loop)})();
</script></body></html>
`;
fs.mkdirSync(OUT,{recursive:true});
const file=path.join(OUT,'seal.html');fs.writeFileSync(file,html);
const buf=Buffer.from(html),sha=crypto.createHash('sha256').update(buf).digest('hex');
const br=zlib.brotliCompressSync(buf,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:11}}).length;
console.log(`${file}\n  size    ${buf.length} bytes (${br} brotli)\n  sha256  ${sha}`);
