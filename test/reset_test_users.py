"""
Reset Clawd beta-test users to a clean, consented state between rounds.

WHY THIS EXISTS
---------------
Two traps cost us a full test round before this was codified:

1. Consent lives in a Redis HASH `consent:<user>` (status/timestamp/version),
   NOT in DynamoDB. Writing consentGiven=true to the prefs table does nothing for
   the live sub-agent -- it stays consent-gated. Seed the Redis hash.

2. Chat history lives in DynamoDB `nanoclaw-chat-messages` (HASH=userId,
   RANGE=timestamp). Clearing Redis does NOT clear it. If left, a new round runs
   on top of the previous round's 100+ turns and the model can MIRROR a prior
   question-type persona onto unrelated new questions (the "charlie file-handler
   bleed"). This script purges per-user history so each round starts clean.

USAGE
-----
This is the reference procedure. In practice we execute the equivalent JS over
SSM -> docker exec against the orchestrator container (which already has the AWS
SDK + ioredis bundled at /app/node_modules), because the test host cannot reach
the private ElastiCache/OpenSearch endpoints directly. The Node payload below is
what the reset runs; keep it in sync with this docstring.
"""

# The orchestrator-side reset payload (Node, ESM-safe CJS). Run via:
#   docker cp reset.cjs nanoclaw-orchestrator:/tmp/reset.cjs
#   docker exec nanoclaw-orchestrator node /tmp/reset.cjs
RESET_NODE_PAYLOAD = r"""
const {SecretsManagerClient,GetSecretValueCommand}=require("/app/node_modules/@aws-sdk/client-secrets-manager");
const {DynamoDBClient}=require("/app/node_modules/@aws-sdk/client-dynamodb");
const {DynamoDBDocumentClient,QueryCommand,BatchWriteCommand}=require("/app/node_modules/@aws-sdk/lib-dynamodb");
const Redis=require("/app/node_modules/ioredis");
(async()=>{
  const sm=new SecretsManagerClient({region:"ap-southeast-1"});
  const j=JSON.parse((await sm.send(new GetSecretValueCommand({SecretId:"nanoclaw/app-config"}))).SecretString);
  const r=new Redis({host:j.redis_host,port:parseInt(j.redis_port),password:j.redis_password,tls:String(j.redis_tls)==="true"?{}:undefined});
  const ddb=DynamoDBDocumentClient.from(new DynamoDBClient({region:"ap-southeast-1"}));
  const CHAT=j.dynamodb_chat_messages_table||"nanoclaw-chat-messages";
  const users=(process.argv[2]||"test_alpha,test_beta,test_charlie,test_delta").split(",");
  for(const u of users){
    // 1) Redis: clear every per-user key (caches, greeted, ratelimit, no_docs, indexing, reminders)
    const k=await r.keys("*"+u+"*"); if(k.length) await r.del(...k);
    // 2) Redis: seed consent = granted (the live consent gate)
    await r.hset("consent:"+u,{status:"granted",timestamp:new Date().toISOString(),version:"1.0",user_id:u});
    await r.expire("consent:"+u,400*24*3600);
    // 3) Redis: suppress onboarding wizard
    await r.set("greeted:"+u,"1");
    // 4) DynamoDB: purge chat history (prevents persona bleed across rounds)
    let removed=0, lastKey=undefined;
    do{
      const q=await ddb.send(new QueryCommand({TableName:CHAT,KeyConditionExpression:"userId = :u",
        ExpressionAttributeValues:{":u":u},ProjectionExpression:"userId, #ts",
        ExpressionAttributeNames:{"#ts":"timestamp"},ExclusiveStartKey:lastKey,Limit:200}));
      const items=q.Items||[];
      for(let i=0;i<items.length;i+=25){
        const batch=items.slice(i,i+25).map(m=>({DeleteRequest:{Key:{userId:m.userId,timestamp:m.timestamp}}}));
        if(batch.length) await ddb.send(new BatchWriteCommand({RequestItems:{[CHAT]:batch}}));
        removed+=batch.length;
      }
      lastKey=q.LastEvaluatedKey;
    } while(lastKey);
    console.log("RESET user="+u+" history_removed="+removed);
  }
  // 5) Clear global rate-limit buckets
  const g=await r.keys("ratelimit:global*"); if(g.length) await r.del(...g);
  console.log("RESET_DONE users="+users.length);
  r.disconnect();
})().catch(e=>{console.log("ERR "+e.message);process.exit(1)});
"""

if __name__ == "__main__":
    print(__doc__)
    print("Node payload length:", len(RESET_NODE_PAYLOAD), "chars")
