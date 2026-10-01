import {bounded,configCheck} from './policy.mjs';
// Cloudflare global fetch only: no VPC bindings, credentials, cookies or caller headers.
// Private networking must never be bound to this deployment. Redirects are forbidden.
export async function upstream(url,method,params={},timeout=8000){
 const start=Date.now();const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-neiro-router-hop':'1'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),redirect:'manual',signal:AbortSignal.timeout(timeout)});
 if(!response.ok)throw Error('Kora unavailable');const value=JSON.parse(await bounded(response));
 if(value.jsonrpc!=='2.0'||value.id!==1||(!('result'in value)&&!value.error))throw Error('Invalid Kora response');
 return {value,ms:Date.now()-start};
}
export async function inspect(url,mint){
 const identity=await upstream(url,'getPayerSigner');const config=await upstream(url,'getConfig');
 return {...configCheck(config.value.result,identity.value.result,mint),latencyMs:config.ms,price:config.value.result.validation_config.price,checkedAt:Date.now(),healthy:true};
}
export async function ownership(row){
 const u=new URL(row.url);u.pathname='/.well-known/neiro-router/'+row.id;u.search='';
 const response=await fetch(u,{redirect:'manual',signal:AbortSignal.timeout(5000),headers:{'accept':'application/json'}});
 if(!response.ok)throw Error('Ownership proof unavailable');const proof=JSON.parse(await bounded(response,1024));
 if(proof.token!==row.token||typeof proof.enabled!=='boolean')throw Error('Ownership proof mismatch');
 return proof.enabled;
}
