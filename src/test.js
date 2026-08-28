import { createServer }   from 'http';
import { request as httpReq } from 'http';
import { WebSocket }      from 'ws';
import { createWsServer, attachHttpHandlers } from './transport/wsServer.js';
import { Actions }        from './game/actions.js';
import { STATUS }         from './game/GameState.js';

let p=0,f=0;
const chk=(l,c)=>{ if(c){console.log('  OK  '+l);p++;}else{console.error('  FAIL '+l);f++;} };
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const waitMsg=(ws,t,ms=3000)=>new Promise((res,rej)=>{
  const timer=setTimeout(()=>rej(new Error('TO:'+t)),ms);
  const fn=(raw)=>{ const m=JSON.parse(raw.toString()); if(m.type===t){clearTimeout(timer);ws.off('message',fn);res(m);} };
  ws.on('message',fn);
});
const waitSU=ws=>waitMsg(ws,'STATE_UPDATE').then(m=>m.state);
const send=(ws,o)=>ws.send(JSON.stringify(o));
const sendA=(ws,a)=>send(ws,{type:'ACTION',action:a});
const openWs=port=>new Promise((res,rej)=>{const ws=new WebSocket('ws://localhost:'+port);ws.once('open',()=>res(ws));ws.once('error',rej);});
const httpGet=(port,path)=>new Promise((res,rej)=>{
  const req=httpReq({hostname:'127.0.0.1',port,path,method:'GET'},r=>{
    let d='';r.on('data',c=>d+=c);
    r.on('end',()=>res({status:r.statusCode,body:JSON.parse(d)}));
  });
  req.on('error',rej);req.end();
});

async function mkRoom(port,n1,n2){
  const ws1=await openWs(port),ws2=await openWs(port);
  send(ws1,{type:'JOIN',playerName:n1});
  const c1=await waitMsg(ws1,'CONNECTED');
  send(ws2,{type:'JOIN',gameId:c1.gameId,playerName:n2});
  const c2=await waitMsg(ws2,'CONNECTED');
  const st=await waitSU(ws1);
  return {ws1,ws2,c1,c2,st};
}

const http=createServer();
const {wss,rooms}=createWsServer(http,{reconnectMs:200});
attachHttpHandlers(http,()=>rooms);
await new Promise(r=>http.listen(0,r));
const port=http.address().port;

async function run(){
  console.log('\n[ applyAction ]');
  const {GameEngine}=await import('./game/GameEngine.js');
  const {applyAction}=await import('./game/actions.js');
  const eng=new GameEngine();
  chk('START_GAME',applyAction(eng,Actions.startGame()).ok);
  chk('Durum',eng.getState().status!==STATUS.WAITING);

  console.log('\n[ Tek baglanti ]');
  {
    const ws=await openWs(port);
    send(ws,{type:'JOIN',playerName:'S'});
    const c=await waitMsg(ws,'CONNECTED');
    chk('CONNECTED',c.type==='CONNECTED');
    chk('gameId',typeof c.gameId==='string');
    chk('playerId',['player1','player2'].includes(c.playerId));
    chk('waiting',c.state.status===STATUS.WAITING);
    ws.terminate();await wait(50);
  }

  console.log('\n[ Iki oyuncu ]');
  {
    const {ws1,ws2,c1,c2,st}=await mkRoom(port,'A','B');
    chk('Farkli slot',c1.playerId!==c2.playerId);
    chk('Basladi',[STATUS.AUCTION,STATUS.ROUND_RESULT].includes(st.status));
    ws1.terminate();ws2.terminate();await wait(50);
  }

  console.log('\n[ Teklif & Pas ]');
  {
    const {ws1,ws2,c1,c2,st}=await mkRoom(port,'T1','T2');
    let s=st;
    if(s.status===STATUS.AUCTION){
      const b=s.auction.activeBidderId;
      const wb=b===c1.playerId?ws1:ws2,wo=b===c1.playerId?ws2:ws1;
      const op=b===c1.playerId?c2.playerId:c1.playerId;
      sendA(wb,Actions.placeBid(b,3));
      s=await waitSU(ws1);
      chk('amount=3',s.auction?.currentBid?.amount===3);
      chk('Sira',s.auction?.activeBidderId!==b);
      sendA(wb,Actions.placeBid(b,5));
      const rej=await waitMsg(wb,'ACTION_REJECTED');
      chk('Yetkisiz',rej.type==='ACTION_REJECTED');
      sendA(wo,Actions.pass(op));
      s=await waitSU(ws1);
      chk('round_result',s.status===STATUS.ROUND_RESULT);
      chk('Kazanan',typeof s.roundResult.winnerId==='string');
    } else { chk('Oto-dagitim',s.status===STATUS.ROUND_RESULT); }
    ws1.terminate();ws2.terminate();await wait(50);
  }

  console.log('\n[ Kopma bildirimi ]');
  {
    const {ws1,ws2}=await mkRoom(port,'K1','K2');
    ws2.terminate();
    const d=await waitMsg(ws1,'OPPONENT_DISCONNECTED',1000);
    chk('Kopma',d.type==='OPPONENT_DISCONNECTED');
    ws1.terminate();await wait(50);
  }

  console.log('\n[ Gecersiz JSON ]');
  {
    const ws=await openWs(port);
    ws.send('bozuk{{');
    chk('ERROR',(await waitMsg(ws,'ERROR')).type==='ERROR');
    ws.terminate();await wait(50);
  }

  console.log('\n[ JOIN olmadan ACTION ]');
  {
    const ws=await openWs(port);
    sendA(ws,Actions.advanceRound());
    chk('ERROR',(await waitMsg(ws,'ERROR')).type==='ERROR');
    ws.terminate();await wait(50);
  }

  console.log('\n[ HTTP Health ]');
  {
    const r=await httpGet(port,'/health');
    chk('200',r.status===200);
    chk('ok',r.body.ok===true);
  }

  console.log('\n[ Tam oyun ]');
  {
    const {ws1,ws2,c1,c2,st}=await mkRoom(port,'F1','F2');
    let s=st;
    for(let t=0;t<10;t++){
      if(s.status===STATUS.AUCTION){
        const b=s.auction.activeBidderId;
        const wb=b===c1.playerId?ws1:ws2,wo=b===c1.playerId?ws2:ws1;
        const op=b===c1.playerId?c2.playerId:c1.playerId;
        sendA(wb,Actions.placeBid(b,1));
        s=await waitSU(ws1);
        if(s.status===STATUS.AUCTION){sendA(wo,Actions.pass(op));s=await waitSU(ws1);}
      }
      if(s.status===STATUS.ROUND_RESULT){sendA(ws1,Actions.advanceRound());s=await waitSU(ws1);}
    }
    chk('Collection',s.status===STATUS.COLLECTION);
    sendA(ws1,Actions.startBattle());s=await waitSU(ws1);
    chk('Battle',s.status===STATUS.BATTLE);
    for(let m=0;m<5;m++){
      sendA(ws1,Actions.revealBattle());s=await waitSU(ws1);
      chk('Revealed '+(m+1),s.battle.revealed);
      sendA(ws1,Actions.nextBattle());s=await waitSU(ws1);
    }
    chk('Final',s.status===STATUS.FINAL);
    chk('Skor=5',s.battle.scores.player1+s.battle.scores.player2===5);
    ws1.terminate();ws2.terminate();await wait(50);
  }
}

await run().catch(err=>{console.error('HATA:',err.message);f++;});

// Temiz kapatış
wss.clients.forEach(ws=>ws.terminate());
await new Promise(r=>setTimeout(r,100));
wss.close();
http.closeAllConnections();
http.close();

console.log('\n'+'-'.repeat(50));
console.log('OK '+p+'  FAIL '+f+'  toplam '+(p+f));
process.exit(f>0?1:0);
