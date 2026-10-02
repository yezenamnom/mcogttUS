using System.Text.Json;
using System.Text;

internal static partial class Program
{
    sealed partial class MainForm
    {
        TabPage InstructionsTab()
        {
            var tab=new TabPage("GPT US Instructions");
            var editor=new TextBox{Dock=DockStyle.Fill,Multiline=true,ScrollBars=ScrollBars.Both,WordWrap=false,Font=new Font("Consolas",10)};
            var bar=new FlowLayoutPanel{Dock=DockStyle.Top,AutoSize=true};
            var notice=new Label{Dock=DockStyle.Bottom,Height=48,Text="Load the current server instructions. Edit Markdown here; saved changes require refreshing the ChatGPT connector session."};
            tab.Controls.Add(editor);tab.Controls.Add(bar);tab.Controls.Add(notice);
            string? hash=null; string? committed=null;
            async Task Request(string method,string? body=null,bool reset=false)
            {
                editor.ReadOnly=true;foreach(Control control in bar.Controls)control.Enabled=false;
                try{
                    using var client=new HttpClient{Timeout=TimeSpan.FromSeconds(15)};
                    using var request=new HttpRequestMessage(new HttpMethod(method),Config.BridgeUrl.TrimEnd('/')+"/instructions"+(reset?"/reset":""));
                    request.Headers.Authorization=new("Bearer",Config.BridgeToken);
                    if(body!=null)request.Content=new StringContent(JsonSerializer.Serialize(new{text=body,expectedHash=hash}),Encoding.UTF8,"application/json");
                    using var response=await client.SendAsync(request);
                    var json=await response.Content.ReadAsStringAsync();using var doc=JsonDocument.Parse(json);
                    if(!response.IsSuccessStatusCode)throw new Exception(doc.RootElement.TryGetProperty("error",out var error)?error.GetString():"Request failed");
                    editor.Text=doc.RootElement.GetProperty("text").GetString();committed=editor.Text;hash=doc.RootElement.GetProperty("sha256").GetString();
                    notice.Text=method=="GET"?"Loaded current instructions. Import previews only; use Validate & Save to apply.":"Saved and backed up on the server. Refresh the ChatGPT connector session to receive new MCP instructions.";
                }catch(Exception error){notice.Text=error.Message;}
                finally{editor.ReadOnly=false;foreach(Control control in bar.Controls)control.Enabled=true;}
            }
            void Button(string title,Action action){var button=new Button{Text=title,AutoSize=true};button.Click+=(_,__)=>{try{action();}catch(Exception error){notice.Text=error.Message;}};bar.Controls.Add(button);}
            Button("Load / Preview",()=>{_ = Request("GET");});
            Button("Import .md",()=>{
                using var dialog=new OpenFileDialog{Filter="GPT US Markdown (*.md)|*.md"};
                if(dialog.ShowDialog()!=DialogResult.OK)return;
                if(new FileInfo(dialog.FileName).Length>128*1024)throw new Exception("File exceeds 128 KB");
                editor.Text=File.ReadAllText(dialog.FileName,new UTF8Encoding(false,true));notice.Text="Imported for preview. Nothing has been applied yet. Use Validate & Save.";
            });
            Button("Export Current .md",()=>{if(committed==null)throw new Exception("Load current instructions before exporting");using var dialog=new SaveFileDialog{Filter="Markdown (*.md)|*.md",FileName="GPT-US-Instructions.md"};if(dialog.ShowDialog()==DialogResult.OK)File.WriteAllText(dialog.FileName,committed,new UTF8Encoding(false));});
            Button("Validate & Save",()=>{if(hash==null)throw new Exception("Load current instructions before saving");_ = Request("PUT",editor.Text);});
            Button("Restore Default",()=>{if(hash==null)throw new Exception("Load current instructions first");_ = Request("POST",editor.Text,true);});
            return tab;
        }
    }
}
