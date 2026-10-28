import { MuseError } from './errors.js';
import { MAX_BODY } from './transport.js';
function waitFor(promise,signal) {
  if(signal.aborted)return Promise.reject(new MuseError('operation aborted; delivery may be uncertain'));
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new MuseError('operation aborted; delivery may be uncertain'));
    signal.addEventListener('abort',abort);
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
export class Socket {
  #ws; #queue=[]; #bytes=0; #pending; #error; #opening; #resolve; #reject;
  constructor(url) {
    this.#opening=new Promise((resolve,reject)=>{this.#resolve=resolve;this.#reject=reject;});
    this.#opening.catch(()=>{});
    this.#ws=new WebSocket(String(url));
    this.#ws.binaryType='arraybuffer';
    this.#ws.onopen=()=>this.#resolve();
    this.#ws.onerror=this.#ws.onclose=event=>{
      if(!this.#error)console.error(`Muse WebSocket ${event?.type}${event?.code?` (code ${event.code})`:''}`);
      this.close();
    };
    this.#ws.onmessage=event=>{
      if(this.#error)return;
      if(typeof event.data==='string'){this.close();return;}
      const bytes=Buffer.from(event.data);
      if(bytes.length>65535){this.close();return;}
      if(this.#pending){const p=this.#pending;this.#pending=null;p.resolve(bytes);}
      else {
        this.#bytes+=bytes.length;
        if(this.#bytes>MAX_BODY||this.#queue.length>=4096)this.close();
        else this.#queue.push(bytes);
      }
    };
  }
  async open(signal){await waitFor(this.#opening,signal);}
  async read(signal){
    if(this.#error)throw this.#error;
    if(signal.aborted)throw new MuseError('operation aborted');
    if(this.#queue.length){const b=this.#queue.shift();this.#bytes-=b.length;return b;}
    if(this.#pending)throw new MuseError('concurrent socket reads are unsupported');
    return waitFor(new Promise((resolve,reject)=>{this.#pending={resolve,reject};}),signal);
  }
  async write(bytes,signal){
    if(this.#error)throw this.#error;
    if(signal.aborted)throw new MuseError('operation aborted');
    this.#ws.send(Uint8Array.from(bytes));
  }
  close(){
    if(this.#error)return;
    this.#error=new MuseError('Muse connection closed; delivery may be uncertain');
    this.#reject(this.#error);this.#pending?.reject(this.#error);this.#pending=null;
    this.#queue=[];this.#bytes=0;
    try{this.#ws.close(1000,'');}catch{}
  }
}
