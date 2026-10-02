// Keep screenshots visible to MCP clients instead of burying base64 in JSON.
export function imageResult(value) {
  const images=[];
  function visit(node) {
    if(Array.isArray(node)) return node.map(visit);
    if(!node || typeof node!=="object") return node;
    if(typeof node.data==="string" && /^image\/(png|jpeg|webp)$/.test(node.mimeType||"")) {
      const {data,...metadata}=node;
      images.push({type:"image",data,mimeType:node.mimeType});
      return {...metadata,imageContentIndex:images.length-1};
    }
    return Object.fromEntries(Object.entries(node).map(([key,item])=>[key,visit(item)]));
  }
  const metadata=visit(value);
  return {content:[...images,{type:"text",text:JSON.stringify(metadata,null,2)}]};
}
