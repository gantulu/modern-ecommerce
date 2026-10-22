import { createClient } from "npm:@supabase/supabase-js@2";
const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const merchant = Deno.env.get("DUITKU_MERCHANT_CODE"), apiKey = Deno.env.get("DUITKU_API_KEY");
const db = url && key ? createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}}) : null;
const text = (s:string,n:number) => new Response(s,{status:n,headers:{"content-type":"text/plain; charset=utf-8","cache-control":"no-store"}});
const hex = (b:Uint8Array) => [...b].map(x=>x.toString(16).padStart(2,"0")).join("");
async function hmac(s:string,k:string){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(k),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return hex(new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(s))));}
async function sha(s:string){return hex(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s))));}
function equal(a:string,b:string){const x=new TextEncoder().encode(a.toLowerCase()),y=new TextEncoder().encode(b.toLowerCase());if(x.length!==y.length)return false;let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];return d===0;}
Deno.serve(async req=>{
 if(req.method!=="POST")return text("Method Not Allowed",405);
 if(!db||!merchant||!apiKey)return text("Server Configuration Error",500);
 let p:Record<string,unknown>;
 try{const raw=await req.text(),ct=req.headers.get("content-type")??"";if(ct.includes("application/json")){const v=JSON.parse(raw);if(!v||typeof v!=="object"||Array.isArray(v))return text("Bad Parameter",400);p=v;}else p=Object.fromEntries(new URLSearchParams(raw).entries());}catch{return text("Bad Parameter",400);}
 const g=(k:string)=>String(p[k]??"").trim();
 const mc=g("merchantCode"),amtText=g("amount"),moid=g("merchantOrderId"),sig=g("signature"),code=g("resultCode");
 if(!mc||!amtText||!moid||!sig||!code)return text("Bad Parameter",400);
 const amount=Number(amtText);if(!Number.isSafeInteger(amount)||amount<=0)return text("Bad Amount",400);
 const valid=mc===merchant&&equal(sig,await hmac(mc+amtText+moid,apiKey));
 const fingerprint=await sha([mc,amtText,moid,code,g("reference"),g("paymentCode"),g("settlementDate"),sig].join("|"));
 const {data:payment,error:payErr}=await db.from("mec_payments").select("id,order_id,merchant_order_id,amount_idr,payment_status").eq("merchant_order_id",moid).maybeSingle();
 if(payErr)return text("Server Error",500);
 const {data:event,error:eventErr}=await db.from("mec_payment_events").select("id,signature_valid,processing_status").eq("event_fingerprint",fingerprint).maybeSingle();
 if(eventErr)return text("Server Error",500);
 if(event?.processing_status==="processed"&&event.signature_valid&&valid)return text("OK",200);
 if(!event){
   const {error}=await db.from("mec_payment_events").insert({payment_id:payment?.id??null,merchant_order_id:moid,provider:"duitku",event_fingerprint:fingerprint,signature_valid:valid,event_type:"callback",provider_status_code:code,processing_status:valid?"received":"failed",error_code:valid?null:"INVALID_SIGNATURE",payload:{merchantCode:mc,amount:amtText,merchantOrderId:moid,resultCode:code,reference:g("reference"),paymentCode:g("paymentCode")}});
   if(error&&error.code!=="23505"){console.error("event insert failed",error.message);return text("Server Error",500);}
 }else if(!valid||!event.signature_valid)return text("Bad Signature",401);
 if(!valid)return text("Bad Signature",401);
 if(!payment){await db.from("mec_payment_events").update({processing_status:"failed",error_code:"PAYMENT_NOT_FOUND"}).eq("event_fingerprint",fingerprint);return text("Payment Not Found",404);}
 if(Number(payment.amount_idr)!==amount){await db.from("mec_payment_events").update({processing_status:"failed",error_code:"AMOUNT_MISMATCH"}).eq("event_fingerprint",fingerprint);return text("Amount Mismatch",400);}
 if(code!=="00"&&code!=="01"){await db.from("mec_payment_events").update({processing_status:"failed",error_code:"UNSUPPORTED_RESULT_CODE"}).eq("event_fingerprint",fingerprint);return text("Unsupported Result Code",400);}
 const now=new Date().toISOString(),success=code==="00";
 if(payment.payment_status!=="paid"){
   const {error}=await db.from("mec_payments").update({payment_status:success?"paid":"failed",provider_reference:g("reference")||null,provider_status_code:code,provider_status_message:success?"SUCCESS":"FAILED",paid_at:success?now:null,updated_at:now}).eq("id",payment.id);
   if(error){console.error("payment update failed",error.message);return text("Server Error",500);}
 }
 if(success){
   const {data:order,error}=await db.from("mec_orders").select("id,order_status,inventory_reservation_status").eq("id",payment.order_id).single();
   if(error||!order)return text("Server Error",500);
   if(order.order_status==="pending_payment"&&order.inventory_reservation_status==="reserved"){
     const {error:updateError}=await db.from("mec_orders").update({order_status:"confirmed",inventory_reservation_status:"consumed",updated_at:now}).eq("id",order.id).eq("order_status","pending_payment").eq("inventory_reservation_status","reserved");
     if(updateError){console.error("order update failed",updateError.message);return text("Server Error",500);}
   }else if(order.order_status==="cancelled"||order.inventory_reservation_status==="released"){
     await db.from("mec_payment_events").update({processing_status:"failed",error_code:"PAID_AFTER_RESERVATION_RELEASED"}).eq("event_fingerprint",fingerprint);
     return text("Payment requires reconciliation",409);
   }
 }
 const {error:updateEventError}=await db.from("mec_payment_events").update({processing_status:"processed",processed_at:now,error_code:null}).eq("event_fingerprint",fingerprint);
 if(updateEventError){console.error("event update failed",updateEventError.message);return text("Server Error",500);}
 return text("OK",200);
});