import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { FoundationServiceError } from "@/services/foundation/errors";
import type { MutationContext, MutationResult } from "@/services/foundation/types";
import {
  approveGitWriteConfirmation,
  readPreparedGitOperation,
} from "@/services/github-write-previews";

export async function approvePreparedGitWriteConfirmation(
  input:{
    workspaceId:string;
    projectId:string;
    preparedOperationId:string;
    confirmationId:string;
    actionDigest:string;
    expectedRevision:number;
  },
  context:MutationContext,
  pool:Pool=postgresPool(),
):Promise<MutationResult<{confirmationId:string;status:"approved";revision:number}>>{
  const prepared=await readPreparedGitOperation({
    workspaceId:input.workspaceId,
    projectId:input.projectId,
    preparedOperationId:input.preparedOperationId,
  },context.actorPrincipalId,pool);
  if(prepared.authorizingPrincipalId!==context.actorPrincipalId){
    throw new FoundationServiceError("CAPABILITY_DENIED","Only the prepared operation authorizer may approve this Git write.");
  }
  if(prepared.confirmationId!==input.confirmationId||prepared.actionDigest!==input.actionDigest||prepared.riskLevel!=="R2"){
    throw new FoundationServiceError("CONFLICT","Confirmation does not belong to the selected prepared Git operation.");
  }
  if(prepared.state!=="prepared"){
    throw new FoundationServiceError("CONFLICT","Prepared Git operation is no longer awaiting approval.");
  }
  return approveGitWriteConfirmation({
    workspaceId:input.workspaceId,
    projectId:input.projectId,
    confirmationId:input.confirmationId,
    actionDigest:input.actionDigest,
    expectedRevision:input.expectedRevision,
  },context,pool);
}
