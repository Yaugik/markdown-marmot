import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import pg from "pg";

const { Pool }=pg;
const databaseUrl=process.env.DATABASE_URL;
const adminUrl=process.env.DATABASE_ADMIN_URL;
const artifact=process.env.RESTORE_ARTIFACT;
const principalId=process.env.OPERATIONS_PRINCIPAL_ID;
const environment=process.env.OPERATIONS_ENVIRONMENT||"development";
if(!databaseUrl||!adminUrl||!artifact||!principalId)throw new Error("DATABASE_URL, DATABASE_ADMIN_URL, RESTORE_ARTIFACT, and OPERATIONS_PRINCIPAL_ID are required.");
const drillId=randomUUID();const databaseName=`folio_restore_${drillId.replaceAll("-","")}`;const primary=new Pool({connectionString:databaseUrl});const admin=new Pool({connectionString:adminUrl});
await primary.query(`INSERT INTO operational_drills(id,drill_kind,environment,state,artifact_ref,started_by_principal_id) VALUES($1,'restore',$2,'running',$3,$4)`,[drillId,environment,artifact,principalId]);
const run=(command,args)=>new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:"inherit",env:process.env});child.once("error",reject);child.once("exit",(code)=>code===0?resolve():reject(new Error(`${command} exited with ${code}`)));});
try{const hash=createHash("sha256");await new Promise((resolve,reject)=>{const stream=createReadStream(artifact);stream.on("data",(chunk)=>hash.update(chunk));stream.on("end",resolve);stream.on("error",reject);});await admin.query(`CREATE DATABASE ${databaseName}`);const target=new URL(adminUrl);target.pathname=`/${databaseName}`;await run("pg_restore",["--dbname",target.toString(),"--no-owner","--no-privileges","--exit-on-error",artifact]);const restored=new Pool({connectionString:target.toString()});const migration=await restored.query(`SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1`);const counts=await restored.query(`SELECT (SELECT count(*) FROM workspaces) workspaces,(SELECT count(*) FROM projects) projects,(SELECT count(*) FROM pages) pages,(SELECT count(*) FROM activity_events) activity_events`);await restored.end();await primary.query(`UPDATE operational_drills SET state='succeeded',artifact_sha256=$2,completed_at=now(),target_schema_version=$3,result_summary=$4 WHERE id=$1`,[drillId,hash.digest("hex"),migration.rows[0]?.name??null,{databaseName,...counts.rows[0]}]);console.log(JSON.stringify({drillId,databaseName,schemaVersion:migration.rows[0]?.name??null,counts:counts.rows[0]}));}catch(error){await primary.query(`UPDATE operational_drills SET state='failed',completed_at=now(),failure_code='RESTORE_FAILED',failure_message=$2 WHERE id=$1`,[drillId,error instanceof Error?error.message.slice(0,500):"Restore failed"]);throw error;}finally{await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,[databaseName]).catch(()=>undefined);await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`).catch(()=>undefined);await primary.end();await admin.end();}
