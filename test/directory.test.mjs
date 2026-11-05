import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync, sign} from 'node:crypto';
import {discover, listingFresh, listingConfigMatches, syncDirectory} from '../src/directory.ts';
import {MAINNET_GENESIS} from '../src/readiness.ts';
import {PROGRAM, MINT, keybytes, keystring, recordAddress, attestationMessage} from '../src/listing/read-record.mjs';
import {database, fixture, insert} from './helpers.mjs';

const now=Date.now(), sec=Math.floor(now/1000), slot=100;
const pair=generateKeyPairSync('ed25519');
const operator=keystring(pair.publicKey.export({format:'der',type:'spki'}).subarray(-32));
const record=recordAddress(operator), blockhash='11111111111111111111111111111111';
function listing(patch={}) {
 const terms={v:5,operator,payment:operator,url:'https://kora.example.com/',mint:MINT,genesis:MAINNET_GENESIS,oracle:'Jupiter',price:{type:'margin',margin:0.01},anchor_slot:slot,anchor_blockhash:blockhash,...patch};
 const body=Buffer.from(JSON.stringify(terms)), data=Buffer.alloc(733);data[0]=1;keybytes(operator).copy(data,1);data.write('NEIRO069',33);data.writeUInt16LE(body.length,41);body.copy(data,43);
 sign(null,attestationMessage(record,MAINNET_GENESIS,body),pair.privateKey).copy(data,43+body.length);
 return {pubkey:record,account:{owner:PROGRAM,executable:false,data:[data.toString('base64'),'base64']}};
}
function chain(records=[listing()], anchorTime=sec-100) {
 const clock=Buffer.alloc(40);clock.writeBigUInt64LE(100n);clock.writeBigInt64LE(BigInt(sec),32);
 return async(method)=>{
 if(method==='getGenesisHash') return MAINNET_GENESIS;
 if(method==='getProgramAccounts')return {context:{slot},value:records};
 if(method==='getAccountInfo')return {context:{slot},value:{owner:'Sysvar1111111111111111111111111111111111111',executable:false,data:[clock.toString('base64'),'base64']}};
 if(method==='getBlock')return {blockhash,blockTime:anchorTime};
 assert.fail(method);
 };
}
const env={NEIRO_MINT:MINT};
test('same P2P verifier accepts signed v5 terms and isolates invalid records',async()=>{
 const invalid=listing();const data=Buffer.from(invalid.account.data[0],'base64');data[50]^=1;invalid.account.data[0]=data.toString('base64');
 const result=await discover(env,chain([invalid,listing()]),now);
 assert.equal(result.scanned,2);assert.equal(result.rejected,1);assert.equal(result.rows[0].payer,operator);
 assert.equal(result.rows[0].listing.record,record);assert.ok(listingFresh(result.rows[0],now));
 assert.equal(listingFresh(result.rows[0],now+900000),false);
});
test('expired, legacy, wrong-network and private endpoints cannot enter routing',async()=>{
 assert.equal((await discover(env,chain([listing()],sec-172800),now)).rows.length,0);
 for(const patch of [{v:4},{genesis:blockhash},{url:'https://localhost/'},{url:'https://127.0.0.1/'},{url:'https://router.example.com/'}]){
 const result=await discover({...env,ROUTER_HOSTS:'router.example.com'},chain([listing(patch)]),now);assert.equal(result.rows.length,0);
 }
});
test('renewals preserve history identity; endpoint and price changes reset it',async()=>{
 const first=(await discover(env,chain(),now)).rows[0];
 const next=(await discover(env,chain(),now+1)).rows[0];assert.equal(first.id,next.id);
 for(const patch of [{url:'https://other.example.com/'},{price:{type:'margin',margin:0.02}}]){
 assert.notEqual((await discover(env,chain([listing(patch)]),now)).rows[0].id,first.id);
 }
 assert.ok(listingConfigMatches(first,{fee_payers:[operator],validation_config:{price:{type:'margin',margin:0.01},price_source:'Jupiter'}}));
 assert.equal(listingConfigMatches(first,{fee_payers:[operator],validation_config:{price:{type:'margin',margin:3},price_source:'Jupiter'}}),false);
});
test('RPC failure cannot replace the directory; complete empty scan removes retired entries',async(t)=>{
 const DB=database(), e={...env,DB}, row=await fixture(e);insert(DB,row);t.after(()=>DB.sql.close());
 let failing=true;const rpc=chain([]);
 t.mock.method(globalThis,'fetch',async(_url,options)=>{
 if(failing)throw Error('RPC down');
 return Response.json({jsonrpc:'2.0',id:1,result:await rpc(JSON.parse(options.body).method)});
 });
 await syncDirectory(e);assert.equal(DB.sql.prepare('SELECT COUNT(*) AS n FROM operators').get().n,1);
 DB.sql.exec('DELETE FROM regional_leases');failing=false;
 await syncDirectory(e);assert.equal(DB.sql.prepare('SELECT COUNT(*) AS n FROM operators').get().n,0);
});
