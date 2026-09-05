# kanaterm シェル統合スクリプト
#
# 1) 端末との文字コードを UTF-8 に揃える
#    xterm.js 側は入出力を UTF-8 として解釈する。Windows PowerShell の既定は
#    コンソールのコードページ(日本語環境では CP932)なので、揃えておかないと
#    日本語の出力が文字化けする。
# 2) プロンプトが描画されるたびに OSC 7 (file://.../<cwd>) を端末へ送出し、
#    kanaterm 側がカレントディレクトリの変化を検知できるようにする。
#
# ユーザー自身の $PROFILE はこのスクリプトの実行前に通常どおり読み込まれるため、
# ユーザーのプロンプトカスタマイズ（oh-my-posh 等）はそのまま活きる。

try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [Console]::OutputEncoding = $utf8NoBom
    [Console]::InputEncoding = $utf8NoBom
    $global:OutputEncoding = $utf8NoBom
} catch {
    # ホストによっては設定できないことがある。文字化けはするが動作自体は続けられる。
}

# 二重に読み込まれると、ラップ済みの prompt を「元の prompt」として掴んでしまい
# 無限再帰になる。差し替えは1回だけにする。
if (-not $global:__kanatermPromptInstalled) {
    $global:__kanatermPromptInstalled = $true
    $global:__kanatermOriginalPrompt = $function:prompt

    # Windowsのパスを file:// URI へ変換する。
    # 各セグメントを個別にエスケープするので、空白・# ・日本語を含むパスでも壊れない
    # (エスケープ結果は ASCII のみになるため、端末の文字コードにも左右されない)。
    function global:__kanatermPathToUri([string]$literalPath) {
        if ($literalPath.StartsWith('\\')) {
            # UNC: \\server\share\dir -> file://server/share/dir
            $escaped = $literalPath.Substring(2) -split '\\' |
                ForEach-Object { [uri]::EscapeDataString($_) }
            return 'file://' + ($escaped -join '/')
        }
        $escaped = $literalPath -split '\\' | ForEach-Object { [uri]::EscapeDataString($_) }
        return 'file:///' + ($escaped -join '/')
    }

    function global:prompt {
        # レジストリ等 FileSystem 以外のプロバイダにいる間は file:// URI にならないので
        # 通知しない(端末側で無効なcwdとして扱われるのを防ぐ)
        if ($PWD.Provider.Name -eq 'FileSystem') {
            $esc = [char]27
            $uri = __kanatermPathToUri $PWD.ProviderPath
            # Write-Host はホストの整形を経由するため、制御シーケンスは直接書き出す
            [Console]::Out.Write("$esc]7;$uri$esc\")
        }

        if ($global:__kanatermOriginalPrompt) {
            & $global:__kanatermOriginalPrompt
        } else {
            "PS $($PWD.Path)> "
        }
    }
}
