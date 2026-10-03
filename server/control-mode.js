export const CONTROL_MODES=['auto','desktop','comet','programmatic'];
export const DEFAULT_SHORTCUTS={desktop:'Alt+6',comet:'Alt+7',programmatic:'Alt+8'};
export function validateShortcuts(value){
 const result={};for(const mode of Object.keys(DEFAULT_SHORTCUTS)){const key=String(value?.[mode]||'');if(!/^(Alt|Ctrl|Ctrl\+Alt)\+[0-9A-Z]$/.test(key))throw Error('Use Alt+6 or Ctrl+Alt+Q');result[mode]=key;}
 if(new Set(Object.values(result)).size!==3)throw Error('Shortcuts must be different');return result;
}
export function shortcutMode(event,shortcuts){if(event.repeat||event.shiftKey||event.metaKey||event.isComposing)return null;const key=/^Digit[0-9]$/.test(event.code)?event.code.slice(5):/^Key[A-Z]$/.test(event.code)?event.code.slice(3):'';const combo=(event.ctrlKey?'Ctrl+':'')+(event.altKey?'Alt+':'')+key;return Object.keys(shortcuts).find(mode=>shortcuts[mode]===combo)||null;}
const browserReads=new Set(['bridge_info','list_tabs','get_page','get_viewport','element_map','dom_watch','dom_diff','wait_for','accessibility_tree','layer_observe','screenshot','cdp_status','network_logs','get_working_tab','select_working_tab','clear_working_tab','browser_guided_tour_status','browser_control_mode_get','browser_control_mode_set','browser_use_open','browser_workspace_suggestions','browser_workspace_context','browser_targets_list','browser_targets_clear','browser_target_add','browser_target_add_by_url','browser_target_add_current','browser_target_get','browser_target_status','browser_target_remove','smart_actions_read','smart_actions_save','smart_actions_choose']);
const desktopReads=new Set(['desktop_info','desktop_monitors','desktop_screen_size','desktop_screenshot','desktop_stream_frame','desktop_windows','desktop_current_window','desktop_processes','desktop_system_info','desktop_clipboard_get','desktop_file_exists','desktop_list_files','desktop_layer_observe','desktop_window_capture','desktop_stream_start','desktop_stream_stop','desktop_audio_start','desktop_audio_stop']);
export function assertControlMode(mode,domain,command,args={}){
 if(!CONTROL_MODES.includes(mode))throw Error('Invalid control mode');if(mode==='auto')return;
 if(command==='batch_actions'||(command==='desktop_mouse_action'&&args.kind==='fast_batch')){for(const action of args.actions||[])assertControlMode(mode,domain,action.command,action.args||{});return;}
 if(command==='browser_target_command'){assertControlMode(mode,domain,args.command,args.args||{});return;}
 if(domain==='desktop'){
  if(desktopReads.has(command)||(command==='desktop_control'&&['active','select','observe'].includes(args.kind))||(command==='desktop_mouse_action'&&['smart_actions_read','smart_actions_save','smart_actions_choose'].includes(args.kind)))return;
  if(mode!=='desktop')throw Error('CONTROL_MODE '+mode+': Windows actions are disabled. Use Comet browser tools on the selected target.');
 }else if(mode==='desktop'&&!browserReads.has(command))throw Error('CONTROL_MODE desktop: browser actions are disabled. Use desktop tools on the selected Windows window.');
}
