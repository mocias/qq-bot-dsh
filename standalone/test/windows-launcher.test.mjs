import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('double-click launch scripts parse in Windows PowerShell 5.1', {skip:process.platform!=='win32'}, () => {
  for (const relative of ['../../scripts/start-release.ps1','../scripts/open-panel.ps1']) {
    const file=fileURLToPath(new URL(relative,import.meta.url));
    const script=`$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${file.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object{Write-Output $_.Message};exit 1}`;
    assert.doesNotThrow(()=>execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true}),relative);
  }
});
