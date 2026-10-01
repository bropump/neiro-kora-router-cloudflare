import {upstream} from './upstream.mjs';
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decodeKey(value){if(typeof value!=='string'||value.length<32||value.length>44)throw Error('Invalid public key');let n=0n;for(const c of value){const v=alphabet.indexOf(c);if(v<0)throw Error('Invalid public key');n=n*58n+BigInt(v);}const bytes=new Uint8Array(32);for(let i=31;i>=0;i--){bytes[i]=Number(n&255n);n>>=8n;}if(n)throw Error('Invalid public key');return bytes;}
// A fixed unsigned, zero-instruction sample: no user data, approvals, transfers,
// signatures or account creation. This measures quote service responsiveness,
// not the price or processing time of an arbitrary customer transaction.
export function sampleTransaction(payer,blockhash){const wire=new Uint8Array(134);wire[0]=1;wire[65]=1;wire[68]=1;wire.set(decodeKey(payer),69);wire.set(decodeKey(blockhash),101);return btoa(String.fromCharCode(...wire));}
export function transactionPayer(encoded){
 if(typeof encoded!=='string'||encoded.length>6000||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw Error('Invalid transaction');
 const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));if(bytes.length>1232)throw Error('Invalid transaction');
 let at=0;const short=()=>{let n=0;for(let i=0;i<3;i++){if(at>=bytes.length)throw Error('Invalid transaction');const b=bytes[at++];if(i===2&&(b&252))throw Error('Invalid transaction');n|=(b&127)<<(i*7);if(!(b&128))return n;}throw Error('Invalid transaction');};
 const sigs=short();if(sigs<1||sigs>19)throw Error('Invalid transaction');at+=sigs*64;if(at>=bytes.length)throw Error('Invalid transaction');
 if(bytes[at]&128){if(bytes[at++]!==128)throw Error('Unsupported transaction version');}
 if(bytes[at]!==sigs)throw Error('Invalid transaction');at+=3;const keys=short();if(keys<1||at+keys*32+33>bytes.length)throw Error('Invalid transaction');
 const key=bytes.slice(at,at+32);let n=0n;for(const b of key)n=n*256n+BigInt(b);let s='';while(n){s=alphabet[Number(n%58n)]+s;n/=58n;}for(const b of key){if(b)break;s='1'+s;}return s;
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
