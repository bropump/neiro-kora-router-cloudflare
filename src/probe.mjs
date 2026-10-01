import {upstream} from './upstream.mjs';
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decodeKey(value){if(typeof value!=='string'||value.length<32||value.length>44)throw Error('Invalid public key');let n=0n;for(const c of value){const v=alphabet.indexOf(c);if(v<0)throw Error('Invalid public key');n=n*58n+BigInt(v);}const bytes=new Uint8Array(32);for(let i=31;i>=0;i--){bytes[i]=Number(n&255n);n>>=8n;}if(n)throw Error('Invalid public key');return bytes;}
// A fixed unsigned, zero-instruction sample: no user data, approvals, transfers,
// signatures or account creation. This measures quote service responsiveness,
// not the price or processing time of an arbitrary customer transaction.
export function sampleTransaction(payer,blockhash){const wire=new Uint8Array(134);wire[0]=1;wire[65]=1;wire[68]=1;wire.set(decodeKey(payer),69);wire.set(decodeKey(blockhash),101);return btoa(String.fromCharCode(...wire));}
// Read only the routing address. Kora owns transaction validation; bytes are
// never rebuilt, signed or changed here. Unknown formats can use an explicit pin.
export function transactionPayer(encoded){
 if(typeof encoded!=='string')return undefined;
 try{
  const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));let at=0;
  if(bytes[0]===129){
   // SIMD-0385: version/header/config mask/lifetime/counts, then addresses.
   if(bytes.length<74||bytes[41]===0)return undefined;at=42;
  }else{
   const short=()=>{let n=0;for(let i=0;i<3;i++){if(at>=bytes.length)return NaN;const b=bytes[at++];n|=(b&127)<<(i*7);if(!(b&128))return n;}return NaN;};
   const sigs=short();if(!Number.isFinite(sigs))return undefined;at+=sigs*64;
   if(bytes[at]&128){if(bytes[at++]!==128)return undefined;}
   at+=3;const keys=short();if(!Number.isFinite(keys)||keys<1||at+32>bytes.length)return undefined;
  }
  const key=bytes.slice(at,at+32);if(key.length!==32)return undefined;
  let n=0n;for(const b of key)n=n*256n+BigInt(b);let value='';while(n){value=alphabet[Number(n%58n)]+value;n/=58n;}
  for(const b of key){if(b)break;value='1'+value;}return value;
 }catch{return undefined;}
}
export async function probeQuote(row,mint){
 try{
 const hash=await upstream(row.url,'getBlockhash',{},3000);if(!hash.value.result?.blockhash)return {ok:false,kind:'business'};
 const q=await upstream(row.url,'estimateTransactionFee',{transaction:sampleTransaction(row.payer,hash.value.result.blockhash),fee_token:mint,signer_key:row.payer},4000);
 const v=q.value.result;if(q.value.error)return {ok:false,kind:'business'};
 if(v?.signer_pubkey!==row.payer||v.payment_address!==row.paymentAddress||!Number.isSafeInteger(v.fee_in_token)||v.fee_in_token<0||!Number.isSafeInteger(v.fee_in_lamports)||v.fee_in_lamports<0)return {ok:false,kind:'protocol'};
 return {ok:true,ms:q.ms,kind:'probe',feeInToken:v.fee_in_token,feeInLamports:v.fee_in_lamports};
 }catch{return {ok:false,kind:'transport'};}
}
