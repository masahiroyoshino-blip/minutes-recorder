/**
 * 議事録アプリの設定（管理者だけが直すファイル）
 * どちらも秘密の値ではないので、GitHubに置いて問題ありません。
 *   clientId : Google Cloud で作ったログイン用クライアントID（…apps.googleusercontent.com）
 *   apiUrl   : 裏側GAS「議事録アプリ_API」のウェブアプリURL（…/exec）
 */
window.MINUTES_CONFIG = {
  clientId: 'ここにクライアントIDを貼る',
  apiUrl: 'ここに裏側APIのURLを貼る',
  allowedDomain: 'replayce.co.jp',
  folderName: '議事録アプリ',
  segmentMinutes: 15,
  maxMinutes: 90
};
