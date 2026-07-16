import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import pg from "pg";

const { Pool }=pg;
const databaseUrl=process.env.DATABASE_URL;
const principalId=process.env.OPERATIONS_PRINCIPAL_ID;
const environment=process.env.OPERATIONS_ENVIRONMENT||"development";
const backupDir=process.env.BACKUP_DIR||".local-data/backups";
if(!databaseUrl||!principalId)throw new Error("DATABASE_URL and OPERATIONS_PRINCIPAL_ID are required.");
await mkdir(backupDir,{recursive:true});
const id=randomUUID();const timestamp=new Date().toISOString().replace(/[:.]/g,"-");const output=path.resolve(backupDir,`folio-${timestamp}.dump`);const pool=new Pool({connectionString:databaseUrl});
await pool.query(`INSERT INTO operational_drills(id,drill_kind,environment,state,started_by_principal_id) VALUES($1,'backup',$2,'running',$3)`,[id,environment,principalId]);
const run=(command,args)=>new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:"inherit",env:process.env});child.once("error",reject);child.once("exit",(code)=>code===0?resolve():reject(new Error(`${command} exited with ${code}`)));});
try{await run("pg_dump",["--dbname",databaseUrl,"--format=custom","--no-owner","--no-privileges","--file",output]);const hash=createHash("sha256");await new Promise((resolve,reject)=>{const stream=createReadStream(output);stream.on("data",(chunk)=>hash.update(chunk));stream.on("end",resolve);stream.on("error",reject);});const details=await stat(output);const sha256=hash.digest("hex");await pool.query(`UPDATE operational_drills SET state='succeeded',artifact_ref=$2,artifact_sha256=$3,completed_at=now(),result_summary=$4 WHERE id=$1`,[id,output,sha256,{sizeBytes:details.size,format:"pg_dump_custom"}]);console.log(JSON.stringify({drillId:id,artifact:output,sha256,sizeBytes:details.size}));}catch(error){await pool.query(`UPDATE operational_drills SET state='failed',completed_at=now(),failure_code='BACKUP_FAILED',failure_message=$2 WHERE id=$1`,[id,error instanceof Error?error.message.slice(0,500):"Backup failed"]);throw error;}finally{await pool.end();}
