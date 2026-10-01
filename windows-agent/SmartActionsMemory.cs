using System.Text.Json;

internal static partial class Program
{
 sealed class SmartChoice{public int Number{get;set;}public string Label{get;set;}="";public string Prompt{get;set;}="";public string Source{get;set;}="";}
 sealed class SmartMemory{
  public int SchemaVersion{get;set;}=1;
  public DateTimeOffset UpdatedAt{get;set;}=DateTimeOffset.UtcNow;
  public List<SmartChoice> Options{get;set;}=new();
  public Dictionary<string,int> Usage{get;set;}=new();
 }
 static string SmartMemoryPath=>System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ChatGPTDesktopBridge","smart-actions.json");
 static SmartMemory LoadSmartMemory(){try{return File.Exists(SmartMemoryPath)?JsonSerializer.Deserialize<SmartMemory>(File.ReadAllText(SmartMemoryPath),J)??new():new();}catch{return new();}}
 static void WriteSmartMemory(SmartMemory memory){
  var path=SmartMemoryPath;Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
  var temp=path+".new";File.WriteAllText(temp,JsonSerializer.Serialize(memory,J));File.Move(temp,path,true);
 }
 static object SmartActionsSave(JsonElement args){
  if(!Config.Permissions.Get("filesWrite"))throw new InvalidOperationException("Permission disabled: filesWrite");
  if(!Has(args,"options")||args.GetProperty("options").ValueKind!=JsonValueKind.Array)throw new ArgumentException("Options required");
  var entries=args.GetProperty("options").EnumerateArray().ToArray();
  if(entries.Length>9)throw new ArgumentException("Maximum 9 options");
  var memory=LoadSmartMemory();memory.Options=entries.Select(entry=>{
   var number=I(entry,"number",-1);var label=S(entry,"label");var prompt=S(entry,"prompt");
   if(number<0||number>9||label.Length is <1 or >100||prompt.Length is <1 or >320)throw new ArgumentException("Invalid smart option");
   return new SmartChoice{Number=number,Label=label,Prompt=prompt,Source=S(entry,"source")};
  }).ToList();
  if(memory.Options.Select(item=>item.Number).Distinct().Count()!=memory.Options.Count)throw new ArgumentException("Duplicate option number");
  memory.UpdatedAt=DateTimeOffset.UtcNow;WriteSmartMemory(memory);
  return new{saved=true,path=SmartMemoryPath,count=memory.Options.Count};
 }
 static object SmartActionsRead(){
  if(!Config.Permissions.Get("filesRead"))throw new InvalidOperationException("Permission disabled: filesRead");
  return new{found=File.Exists(SmartMemoryPath),path=SmartMemoryPath,state=LoadSmartMemory()};
 }
 static object SmartActionsChoose(JsonElement args){
  if(!Config.Permissions.Get("filesRead")||!Config.Permissions.Get("filesWrite"))throw new InvalidOperationException("File read/write permission required");
  var number=I(args,"number",-1);var memory=LoadSmartMemory();
  var choice=memory.Options.FirstOrDefault(item=>item.Number==number)??throw new ArgumentException("Numbered option unavailable");
  var key=choice.Label.ToLowerInvariant();memory.Usage[key]=Math.Min(10000,memory.Usage.GetValueOrDefault(key)+1);
  memory.UpdatedAt=DateTimeOffset.UtcNow;WriteSmartMemory(memory);
  return new{number=choice.Number,label=choice.Label,prompt=choice.Prompt,selected=true};
 }
}
