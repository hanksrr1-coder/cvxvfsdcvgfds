const express = require("express");
const http = require("http");
const path = require("path");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const db = new Database(path.join(DATA_DIR, "casino.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  chips INTEGER NOT NULL DEFAULT 1000,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
const getUser = db.prepare("SELECT id, username, chips FROM users WHERE id=?");
const addUser = db.prepare("INSERT INTO users(username,password_hash,chips) VALUES(?,?,1000)");
const updateChips = db.prepare("UPDATE users SET chips=? WHERE id=?");
const sessionMiddleware = session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: DATA_DIR }),
  secret: process.env.SESSION_SECRET || "replace-this-secret-before-deploying",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 7*24*60*60*1000 }
});
app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, "public")));

function currentUser(req) { return req.session.userId ? getUser.get(req.session.userId) : null; }
app.get("/api/me", (req,res) => {
  const u=currentUser(req); res.json({ user: u || null });
});
app.post("/api/register", async (req,res) => {
  const username=String(req.body.username||"").trim();
  const password=String(req.body.password||"");
  if (!/^[a-zA-Z0-9_]{3,18}$/.test(username)) return res.status(400).json({error:"Username must be 3–18 letters, numbers or underscores."});
  if (password.length<8 || password.length>100) return res.status(400).json({error:"Password must be at least 8 characters."});
  try {
    const hash=await bcrypt.hash(password,12);
    const result=addUser.run(username,hash); req.session.userId=result.lastInsertRowid;
    res.json({user:getUser.get(result.lastInsertRowid)});
  } catch(e) { res.status(409).json({error:"That username is already taken."}); }
});
app.post("/api/login", async (req,res) => {
  const username=String(req.body.username||"").trim();
  const row=db.prepare("SELECT * FROM users WHERE username=?").get(username);
  if (!row || !(await bcrypt.compare(String(req.body.password||""),row.password_hash))) return res.status(401).json({error:"Incorrect username or password."});
  req.session.userId=row.id; res.json({user:getUser.get(row.id)});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));

const live = new Map(); // socket.id -> {userId, username, x, z}
const blackjack = { players: new Map(), dealer: [], deck: [], active: false, current: null };
const suits=["♠","♥","♦","♣"];
function newDeck(){const d=[]; for(const s of suits) for(let v=1;v<=13;v++) d.push({v,s}); return d.sort(()=>Math.random()-.5);}
function cardText(c){return {value:c.v,suit:c.s,label:(c.v===1?"A":c.v===11?"J":c.v===12?"Q":c.v===13?"K":c.v)+c.s};}
function score(hand){let n=0,a=0; for(const c of hand){if(c.v===1){n+=11;a++;}else n+=Math.min(c.v,10);} while(n>21&&a){n-=10;a--;} return n;}
function publicBJ(){return {active:blackjack.active, dealer:blackjack.dealer.map(cardText), players:[...blackjack.players.values()].map(p=>({username:p.username,hand:p.hand.map(cardText),bet:p.bet,status:p.status,score:score(p.hand)})),current:blackjack.current};}
function emitBJ(){io.emit("blackjack:state",publicBJ());}
function balance(id){return getUser.get(id)?.chips ?? 0;}
function pay(id,delta){const b=balance(id); if(b+delta<0)return false; updateChips.run(b+delta,id); const u=getUser.get(id); for(const [sid,p] of live) if(p.userId===id) io.to(sid).emit("balance",u.chips); return true;}
function activePlayer(){return blackjack.players.get(blackjack.current);}
function advance(){
  const ids=[...blackjack.players.keys()]; const i=ids.indexOf(blackjack.current);
  for(let k=1;k<=ids.length;k++){const id=ids[(i+k)%ids.length]; const p=blackjack.players.get(id); if(p&&p.status==="playing"){blackjack.current=id;emitBJ();return;}}
  finishBJ();
}
function finishBJ(){
  while(score(blackjack.dealer)<17) blackjack.dealer.push(blackjack.deck.pop());
  const ds=score(blackjack.dealer);
  for(const [id,p] of blackjack.players){
    const ps=score(p.hand);
    if(p.status==="stood"||p.status==="playing"){
      if(ps>21) p.result="Bust";
      else if(ds>21||ps>ds){pay(id,p.bet*2);p.result="Win";}
      else if(ps===ds){pay(id,p.bet);p.result="Push";}
      else p.result="Lose";
    }
  }
  blackjack.active=false;blackjack.current=null;emitBJ();
}
function startBJ(socket,bet){
  const p=live.get(socket.id); if(!p)return;
  if(blackjack.active)return socket.emit("notice","The blackjack hand is already in progress.");
  bet=Math.floor(Number(bet));
  if(!Number.isFinite(bet)||bet<10||bet>5000||!pay(p.userId,-bet))return socket.emit("notice","Bet must be 10–5,000 chips and within your balance.");
  blackjack.players.set(p.userId,{username:p.username,hand:[],bet,status:"playing",result:null});
  if(blackjack.players.size===1){blackjack.deck=newDeck();blackjack.dealer=[];blackjack.active=true;}
  // Additional players can join before the first action; deal all hands on first player.
  if(blackjack.players.size===1){
    for(let i=0;i<2;i++){for(const q of blackjack.players.values())q.hand.push(blackjack.deck.pop());blackjack.dealer.push(blackjack.deck.pop());}
  } else {
    const q=blackjack.players.get(p.userId);q.hand=[blackjack.deck.pop(),blackjack.deck.pop()];
  }
  if(!blackjack.current)blackjack.current=p.userId;
  emitBJ();
}
io.use((socket,next)=>sessionMiddleware(socket.request,{},next));
io.use((socket,next)=>{
  const uid=socket.request.session?.userId; const u=uid&&getUser.get(uid);
  if(!u)return next(new Error("Please sign in first."));
  socket.user=u; next();
});
io.on("connection",socket=>{
  const u=socket.user;
  live.set(socket.id,{userId:u.id,username:u.username,x:0,z:0});
  socket.emit("balance",u.chips);
  socket.emit("world:players",[...live.entries()].filter(([id])=>id!==socket.id).map(([id,p])=>({id,...p})));
  socket.broadcast.emit("world:join",{id:socket.id,username:u.username,x:0,z:0});
  socket.on("world:move",pos=>{
    const p=live.get(socket.id); if(!p)return;
    p.x=Math.max(-45,Math.min(45,Number(pos.x)||0));p.z=Math.max(-45,Math.min(45,Number(pos.z)||0));
    socket.broadcast.emit("world:move",{id:socket.id,x:p.x,z:p.z});
  });
  socket.on("voice:offer",(d)=>{if(live.has(d.to))io.to(d.to).emit("voice:offer",{from:socket.id,offer:d.offer});});
  socket.on("voice:answer",(d)=>{if(live.has(d.to))io.to(d.to).emit("voice:answer",{from:socket.id,answer:d.answer});});
  socket.on("voice:ice",(d)=>{if(live.has(d.to))io.to(d.to).emit("voice:ice",{from:socket.id,candidate:d.candidate});});
  socket.on("blackjack:bet",bet=>startBJ(socket,bet));
  socket.on("blackjack:action",action=>{
    const p=live.get(socket.id),hand=blackjack.players.get(u.id);
    if(!p||!blackjack.active||blackjack.current!==u.id||!hand)return;
    if(action==="hit"){hand.hand.push(blackjack.deck.pop());if(score(hand.hand)>=21){hand.status=score(hand.hand)>21?"bust":"stood";advance();}else emitBJ();}
    else if(action==="stand"){hand.status="stood";advance();}
    else if(action==="double"&&hand.hand.length===2&&pay(u.id,-hand.bet)){
      hand.bet*=2;hand.hand.push(blackjack.deck.pop());hand.status=score(hand.hand)>21?"bust":"stood";advance();
    }
  });
  socket.on("roulette:bet",({kind,value,amount})=>{
    amount=Math.floor(Number(amount));if(!Number.isFinite(amount)||amount<5||amount>5000||!pay(u.id,-amount))return socket.emit("notice","Invalid bet or insufficient chips.");
    const n=Math.floor(Math.random()*37);let win=false,mult=0;
    if(kind==="number"&&Number(value)===n){win=true;mult=36;}
    if(kind==="color"){const red=[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];const color=n===0?"green":red.includes(n)?"red":"black";win=value===color;mult=2;}
    if(kind==="parity"&&n!==0){win=(value==="even"?n%2===0:n%2===1);mult=2;}
    if(win)pay(u.id,amount*mult);
    io.emit("roulette:result",{number:n,color:n===0?"green":([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36].includes(n)?"red":"black"),winner:u.username,won:win,payout:win?amount*mult:0});
  });
  socket.on("slots:spin",amount=>{
    amount=Math.floor(Number(amount));if(!Number.isFinite(amount)||amount<5||amount>1000||!pay(u.id,-amount))return socket.emit("notice","Invalid bet or insufficient chips.");
    const symbols=["🍒","🍋","🔔","💎","7️⃣"];const reels=Array.from({length:3},()=>symbols[Math.floor(Math.random()*symbols.length)]);
    let mult=0;if(reels.every(x=>x===reels[0]))mult=reels[0]==="7️⃣"?25:10;else if(new Set(reels).size===2)mult=2;
    const payout=amount*mult;if(payout)pay(u.id,payout);
    socket.emit("slots:result",{reels,payout,bet:amount});
  });
  socket.on("disconnect",()=>{
    live.delete(socket.id);socket.broadcast.emit("world:leave",socket.id);
    const hand=blackjack.players.get(u.id);if(hand&&blackjack.active){hand.status="stood";if(blackjack.current===u.id)advance();}
    if(!blackjack.active)blackjack.players.delete(u.id);
  });
});
setInterval(()=>{if(!blackjack.active&&blackjack.players.size)blackjack.players.clear();},30000);
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
server.listen(PORT,()=>console.log(`Neon Vault Casino running at http://localhost:${PORT}`));
