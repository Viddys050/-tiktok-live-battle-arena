import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from "tiktok-live-connector";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express(), server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const state = { connected:false, demoMode:true, username:"", roomId:"", likesTotal:0, viewers:0, scores:{putin:0,zelensky:0}, teams:{}, supporters:{}, events:[], chat:[], gifts:[], round:{number:1,secondsLeft:120,running:true} };
let connection = null;
const limit = (a,v,n) => { a.unshift(v); if(a.length>n)a.length=n; };
const safe = (v,n=250) => String(v ?? "").replace(/[<>]/g,"").slice(0,n);
const emit = () => io.emit("state",state);
function event(type,text,extra={}) { const e={id:Date.now()+Math.random(),time:new Date().toISOString(),type,text:safe(text),...extra}; limit(state.events,e,100); io.emit("event",e); }
function teamFor(user,message="") {
 const id=String(user?.userId ?? user?.id ?? user?.uniqueId ?? user?.displayId ?? user?.nickname ?? "viewer");
 const m=String(message).toLowerCase();
 if(/\b(putin|russia|team red)\b/.test(m)) state.teams[id]="putin";
 if(/\b(zelensky|ukraine|team blue)\b/.test(m)) state.teams[id]="zelensky";
 return state.teams[id] || null;
}
function score(team,points){ if(team) state.scores[team]+=Math.max(0,Math.round(points)); }
function processChat(d){
 const u=d.user||{}, name=safe(u.displayId||u.nickname||u.uniqueId||"viewer",60), message=safe(d.comment||d.content||d.text||"",300), team=teamFor(u,message);
 const item={time:new Date().toISOString(),username:name,message,team}; limit(state.chat,item,150); io.emit("chat",item);
 if(team) event("team","@"+name+" joined Team "+(team==="putin"?"Putin / Russia":"Zelensky / Ukraine"),{username:name,team});
 emit();
}
function processGift(d){
 const u=d.user||{}, name=safe(u.displayId||u.nickname||u.uniqueId||"viewer",60);
 const gift=safe(d.giftDetails?.giftName||d.gift?.name||d.extendedGiftInfo?.name||d.giftName||"Gift",80);
 const count=Math.max(1,Number(d.repeatCount||1)), type=Number(d.giftDetails?.giftType??d.gift?.type??d.giftType??0);
 if(type===1 && d.repeatEnd!==true && Number(d.repeatEnd)!==1) return;
 const diamonds=Math.max(1,Number(d.giftDetails?.diamondCount??d.gift?.diamondCount??d.diamondCount??1));
 const team=teamFor(u), points=diamonds*count*10;
 if(team) score(team,points);
 const id=String(u.userId??u.id??u.uniqueId??name), username=name;
 if(!state.supporters[id]) state.supporters[id]={id,username,team:null,points:0,gifts:0};
 Object.assign(state.supporters[id],{username,team:team||state.supporters[id].team});
 state.supporters[id].points+=points; state.supporters[id].gifts+=count;
 const item={time:new Date().toISOString(),username,name:gift,count,diamonds,points,team};
 limit(state.gifts,item,100); io.emit("gift",item);
 event("gift","@"+name+" sent "+gift+" x"+count+(team?" — +"+points+" points":" — type PUTIN or ZELENSKY first"),{username,team,points,giftName:gift});
 emit();
}
function processLike(d){
 const count=Math.max(1,Number(d.likeCount||1)); state.likesTotal+=count;
 const team=state.scores.putin<=state.scores.zelensky?"putin":"zelensky";
 const points=Math.max(1,Math.floor(count/10)); score(team,points);
 event("like","+"+count+" likes — comeback boost for Team "+(team==="putin"?"Putin":"Zelensky"),{team,points});
 emit();
}
async function disconnect(){
 if(connection){try{await connection.disconnect()}catch{}}
 connection=null; state.connected=false; state.roomId=""; emit();
}
async function connect(username){
 await disconnect();
 state.username=safe(String(username||"").replace(/^@/,"").trim(),80);
 if(!state.username) throw new Error("Enter your TikTok username.");
 state.demoMode=false;
 connection=new TikTokLiveConnection(state.username);
 connection.on(WebcastEvent.CHAT,processChat);
 connection.on(WebcastEvent.GIFT,processGift);
 connection.on(WebcastEvent.LIKE,processLike);
 connection.on(WebcastEvent.ROOM_USER,d=>{state.viewers=Number(d.viewerCount||d.total||state.viewers);emit()});
 connection.on(ControlEvent.ERROR,d=>event("system","TikTok connector: "+(d?.info||d?.exception?.message||"connection error")));
 connection.on(ControlEvent.DISCONNECTED,()=>{state.connected=false;event("system","TikTok disconnected.");emit()});
 try{
  const r=await connection.connect(); state.connected=true; state.roomId=String(r?.roomId||connection.roomId||"");
  event("system","Connected to @"+state.username+"'s LIVE."); emit();
 }catch(e){state.connected=false;event("system","Connection failed: "+(e?.message||e));emit();throw e}
}
app.use(express.json({limit:"32kb"}));
app.use(express.static(path.join(root,"public")));
app.get("/api/state",(_q,r)=>r.json(state));
app.get("/health",(_q,r)=>r.json({ok:true,connected:state.connected,demoMode:state.demoMode}));
app.post("/api/connect",async(q,r)=>{try{await connect(q.body?.username);r.json({ok:true,connected:state.connected})}catch(e){r.status(400).json({ok:false,error:safe(e?.message||e,500)})}});
app.post("/api/disconnect",async(_q,r)=>{await disconnect();state.demoMode=true;event("system","Disconnected. Demo mode is available.");r.json({ok:true})});
app.post("/api/demo",(q,r)=>{
 const action=safe(q.body?.action||"",30), team=q.body?.team==="zelensky"?"zelensky":"putin", username=safe(q.body?.username||"DemoViewer",60);
 const user={id:"demo-"+username,displayId:username};
 state.demoMode=true;
 if(action==="chat")processChat({user,comment:team==="putin"?"PUTIN":"ZELENSKY"});
 else if(action==="like")processLike({likeCount:Number(q.body?.count||100)});
 else if(action==="gift")processGift({user,giftName:safe(q.body?.gift||"Rose",80),repeatCount:Number(q.body?.count||1),diamondCount:Number(q.body?.diamonds||1),repeatEnd:true});
 else if(action==="boss"){score(team,1000);event("boss","BOSS EVENT! Team "+team.toUpperCase()+" deals 1,000 damage!",{team,points:1000});emit()}
 else return r.status(400).json({ok:false,error:"Unknown demo action"});
 r.json({ok:true});
});
app.post("/api/round",(q,r)=>{
 if(q.body?.action==="pause")state.round.running=false;
 else if(q.body?.action==="resume")state.round.running=true;
 else if(q.body?.action==="reset"){state.round.secondsLeft=120;state.scores={putin:0,zelensky:0};}
 emit();r.json({ok:true});
});
io.on("connection",s=>{s.emit("state",state);s.emit("snapshot",{chat:state.chat,gifts:state.gifts,events:state.events})});
setInterval(()=>{if(!state.round.running)return;state.round.secondsLeft--;if(state.round.secondsLeft<=0){const winner=state.scores.putin===state.scores.zelensky?"DRAW":state.scores.putin>state.scores.zelensky?"PUTIN":"ZELENSKY";event("round","ROUND "+state.round.number+" WINNER: "+winner);state.round.number++;state.round.secondsLeft=120;state.scores={putin:0,zelensky:0}}emit()},1000);
server.listen(PORT,"0.0.0.0",()=>console.log("Putin vs Zelensky LIVE ARENA listening on port "+PORT));
process.on("SIGINT",async()=>{await disconnect();server.close(()=>process.exit(0))});