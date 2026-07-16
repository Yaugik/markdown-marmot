import { FoundationServiceError } from "@/services/foundation/errors";

export function normalizeRepositoryPath(value:string){
  const path=value.trim().replaceAll("\\","/").replace(/^\.\//,"");
  if(!path||path.length>1000||path.startsWith("/")||path.endsWith("/")||path.includes("\0")||path.split("/").some((segment)=>!segment||segment==="."||segment==="..")){
    throw new FoundationServiceError("VALIDATION_FAILED","Repository path is invalid.");
  }
  return path;
}

export function validateBranchName(value:string){
  const branch=value.trim();
  if(!branch||branch.length>255||branch.startsWith("/")||branch.endsWith("/")||branch.endsWith(".")||branch.includes("..")||branch.includes("@{")||/[~^:?*\[\\\s\x00-\x1f\x7f]/.test(branch)||branch.split("/").some((segment)=>!segment||segment.startsWith(".")||segment.endsWith(".lock"))){
    throw new FoundationServiceError("VALIDATION_FAILED","Git branch name is invalid.");
  }
  return branch;
}

export function validateScopeRule(value:string){
  const rule=value.trim().replaceAll("\\","/").replace(/^\.\//,"");
  if(!rule||rule.length>500||rule.startsWith("/")||rule.includes("\0")||rule.split("/").some((segment)=>segment==="..")){
    throw new FoundationServiceError("VALIDATION_FAILED","Markdown scope rule is invalid.");
  }
  if(/[\x00-\x1f\x7f:]/.test(rule))throw new FoundationServiceError("VALIDATION_FAILED","Markdown scope rule contains unsupported characters.");
  return rule;
}

function escapeRegex(value:string){return value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");}
function globRegex(rule:string){
  let index=0;let output="^";
  while(index<rule.length){
    if(rule[index]==="*"&&rule[index+1]==="*"){
      const followedBySlash=rule[index+2]==="/";
      output+=followedBySlash?"(?:.*/)?":".*";
      index+=followedBySlash?3:2;
      continue;
    }
    if(rule[index]==="*"){output+="[^/]*";index+=1;continue;}
    if(rule[index]==="?"){output+="[^/]";index+=1;continue;}
    output+=escapeRegex(rule[index]!);index+=1;
  }
  return new RegExp(`${output}$`,"u");
}

export function pathMatchesMarkdownScope(pathValue:string,includeRules:string[],excludeRules:string[]){
  const path=normalizeRepositoryPath(pathValue);
  if(!/\.(md|markdown)$/i.test(path))return false;
  const included=includeRules.some((rule)=>globRegex(validateScopeRule(rule)).test(path));
  return included&&!excludeRules.some((rule)=>globRegex(validateScopeRule(rule)).test(path));
}
