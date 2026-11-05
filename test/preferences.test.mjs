import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.ts';
import {preferences,matchesPreferences} from '../src/preferences.ts';
import {checkQuotes,checkQuoteRequest} from '../src/quote-check.ts';
import {database,fixture,insert,mint,payer,cacheFixture,context} from './helpers.mjs';
const quoteCall={jsonrpc:'2.0',id:7,method:'estimateTransactionFee',params:{fee_token:mint,transaction:'unsigned-fixture',signer_key:payer}};
const reply=(patch={})=>({jsonrpc:'2.0',id:7,result:{signer_pubkey:payer,payment_address:payer,fee_in_lamports:5000,fee_in_token:100,...patch}});
test('markup filters exclude incomparable fixed prices and capability filters never relax',async()=>{
 const row=await fixture({NEIRO_MINT:mint});
 assert.ok(matchesPreferences({...row,price:{type:'margin',margin:0.07}},{maxMarkupBps:700}));
 assert.equal(matchesPreferences({...row,price:{type:'margin',margin:0.0701}},{maxMarkupBps:700}),false);
 assert.ok(matchesPreferences(row,{maxMarkupBps:0}));
 assert.equal(matchesPreferences({...row,price:{type:'fixed',amount:1,token:mint,strict:true}},{maxMarkupBps:700}),false);
 assert.ok(matchesPreferences(row,{method:'signTransaction'}));
 assert.equal(matchesPreferences(row,{method:'futureMethod'}),false);
 for(const q of ['maxMarkupBps=-1','maxMarkupBps=0.1','maxMarkupBps=1e3','maxFeeNeiroRaw=18446744073709551616','maxFeeNeiroRaw=1.5','maxMarkupBps=1&maxMarkupBps=2'])assert.throws(()=>preferences(new URLSearchParams(q)));
});
test('quote checks require correct identity, request ID, amount representation and optional token echo',async()=>{
 const row=await fixture({NEIRO_MINT:mint});
 assert.equal(checkQuotes(quoteCall,reply(),row,'100'),null);
 assert.equal(checkQuotes(quoteCall,reply(),row,'99').status,422);
 for(const patch of [{signer_pubkey:'wrong'},{payment_address:'wrong'},{fee_in_token:-1},{fee_in_token:1.5},{fee_in_token:9007199254740992},{fee_in_token:'18446744073709551616'},{fee_token:'wrong'}])assert.equal(checkQuotes(quoteCall,reply(patch),row).status,502);
 assert.equal(checkQuotes(quoteCall,{...reply(),id:8},row).status,502);
 assert.equal(checkQuotes(quoteCall,reply({fee_in_token:'18446744073709551615'}),row,'18446744073709551615'),null);
 assert.equal(checkQuotes(quoteCall,{jsonrpc:'2.0',id:7,error:{code:-1,message:'Kora rejection'}},row,'0'),null);
});
test('fee cap cannot silently apply to signing, missing fee token, notifications or batches',()=>{
 for(const call of [{...quoteCall,method:'signAndSendTransaction'},{...quoteCall,params:{}},{...quoteCall,id:undefined},[quoteCall]])assert.throws(()=>checkQuoteRequest(call,'100',mint));
 checkQuoteRequest(quoteCall,'100',mint);
});
async function setup(t){const DB=database(),env={DB,NEIRO_MINT:mint,REQUEST_LIMIT:{limit:async()=>({success:true})}},row=await fixture(env);insert(DB,row);t.after(()=>DB.sql.close());const cache=cacheFixture(t);cache.set('https://router.example/_regional/CDG/refresh',new Response('1'));return {env,row,DB};}
function req(path,raw){const r=new Request('https://router.example'+path,raw?{method:'POST',headers:{'content-type':'application/json'},body:raw}:{});Object.defineProperty(r,'cf',{value:{colo:'CDG'}});return r;}
test('select returns a pin and separate capped quote URL without upstream requests',async(t)=>{
 const {env,row}=await setup(t),ctx=context();t.mock.method(globalThis,'fetch',()=>assert.fail('selection must not call an operator'));
 const r=await worker.fetch(req('/select?maxMarkupBps=0&method=signTransaction&maxFeeNeiroRaw=100'),env,ctx);assert.equal(r.status,200);const selected=await r.json();
 assert.equal(selected.provider,row.payer);assert.equal(new URL(selected.rpcUrl).searchParams.get('operator'),row.id);assert.equal(new URL(selected.rpcUrl).searchParams.get('maxFeeNeiroRaw'),null);assert.equal(new URL(selected.quoteUrl).searchParams.get('maxFeeNeiroRaw'),'100');await ctx.finish();
});
test('pinned provider still must satisfy markup preferences; no upstream or silent fallback',async(t)=>{
 const {env,row,DB}=await setup(t);row.price={type:'margin',margin:1};DB.sql.prepare('UPDATE operators SET data=? WHERE id=?').run(JSON.stringify(row),row.id);
 t.mock.method(globalThis,'fetch',()=>assert.fail('no eligible provider'));
 const ctx=context(),res=await worker.fetch(req('/rpc?provider='+payer+'&maxMarkupBps=500',JSON.stringify({jsonrpc:'2.0',id:1,method:'getConfig'})),env,ctx);assert.equal(res.status,503);await ctx.finish();
});
for(const [fee,expected] of [[100,200],[101,422]])test('actual quote '+fee+' under cap100 returns '+expected+' with no replay',async(t)=>{
 const {env}=await setup(t),ctx=context(),raw=' '+JSON.stringify(quoteCall)+' ',body=' '+JSON.stringify(reply({fee_in_token:fee}))+' ';const calls=[];
 t.mock.method(globalThis,'fetch',async(_url,options)=>{calls.push(options.body);return new Response(body)});
 const r=await worker.fetch(req('/rpc?maxFeeNeiroRaw=100',raw),env,ctx);assert.equal(r.status,expected);if(expected===200)assert.equal(await r.text(),body);else assert.equal((await r.json()).error.code,-32003);assert.deepEqual(calls,[raw]);await ctx.finish();
});
test('cap on submission is rejected before any upstream call',async(t)=>{
 const {env}=await setup(t);t.mock.method(globalThis,'fetch',()=>assert.fail('must not submit'));const ctx=context();
 const r=await worker.fetch(req('/rpc?maxFeeNeiroRaw=100',JSON.stringify({...quoteCall,method:'signAndSendTransaction'})),env,ctx);assert.equal(r.status,400);await ctx.finish();
});
test('mixed batches remain passthrough without a cap; cap rejects them before forwarding',async()=>{
 const row=await fixture({NEIRO_MINT:mint});const batch=[quoteCall,{jsonrpc:'2.0',id:2,method:'signTransaction'}];
 assert.equal(checkQuotes(batch,[reply({signer_pubkey:'wrong'}),{jsonrpc:'2.0',id:2,result:{}}],row),null);
 assert.throws(()=>checkQuoteRequest(batch,'100',mint));
});
test('free zero-cost quote may omit token amount; a paid quote may not',async()=>{
 const row=await fixture({NEIRO_MINT:mint});assert.equal(checkQuotes(quoteCall,reply({fee_in_lamports:0,fee_in_token:null}),row,'0'),null);
 assert.equal(checkQuotes(quoteCall,reply({fee_in_token:null}),row,'0').status,502);
 assert.equal(checkQuotes(quoteCall,reply({fee_in_lamports:0,fee_in_token:null}),{...row,price:{type:'margin',margin:0}},'0').status,502);
});
