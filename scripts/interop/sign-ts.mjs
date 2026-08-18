// Sign a valid AP2 payment-mandate chain with ap2-protocol-js (TypeScript),
// emit JSON for the reference Python verifier. Proves TS -> reference interop.
import { createMandate, presentMandate } from "../../dist/index.mjs";
const subtle = crypto.subtle;
async function kp(kid){const p=await subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);return{pub:{...(await subtle.exportKey("jwk",p.publicKey)),kid,alg:"ES256"},priv:{...(await subtle.exportKey("jwk",p.privateKey)),kid,alg:"ES256"}};}
const issuer=await kp("issuer-ts"),agent=await kp("agent-ts");
const AUD="merchant",NONCE="ts-nonce-1",TXID="tx_ts_1",HASH="ts-checkout-hash";
const open=await createMandate({payload:{vct:"mandate.payment.open.1",constraints:[{type:"payment.reference",conditional_transaction_id:HASH},{type:"payment.amount_range",currency:"USD",min:100,max:5000}],cnf:{jwk:{kty:agent.pub.kty,crv:agent.pub.crv,x:agent.pub.x,y:agent.pub.y,kid:agent.pub.kid}}},issuerKey:issuer.priv});
const chain=await presentMandate({holderKey:agent.priv,mandateToken:open,payload:{vct:"mandate.payment.1",transaction_id:TXID,payee:{id:"s-1",name:"Shop"},payment_amount:{currency:"USD",amount:1000},payment_instrument:{id:"pi-1",type:"credit"}},aud:AUD,nonce:NONCE});
const issuerPub={kty:issuer.pub.kty,crv:issuer.pub.crv,x:issuer.pub.x,y:issuer.pub.y,kid:issuer.pub.kid};
console.log(JSON.stringify({token:chain,issuer_jwk:issuerPub,expected_aud:AUD,expected_nonce:NONCE,expected_transaction_id:TXID,expected_open_checkout_hash:HASH}));
