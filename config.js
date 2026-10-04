/**
 * 議事録アプリの設定（管理者だけが直すファイル）
 * どちらも秘密の値ではないので、GitHubに置いて問題ありません。
 *   clientId : Google Cloud で作ったログイン用クライアントID（…apps.googleusercontent.com）
 *   apiUrl   : 裏側GAS「議事録アプリ_API」のウェブアプリURL（…/exec）
 */
window.MINUTES_CONFIG = {
  clientId: '587982494338-389rmsmd5b20ogu2is01ujh8bdlr9571.apps.googleusercontent.com',
  apiUrl: 'https://script.google.com/macros/s/AKfycbzYVWAH6OR1GjM9k1OVKNK26eBLLusVW-XtljbpEqK-7Bp2JCckm_t11knz1nvH3q7r/exec',
  allowedDomain: 'replayce.co.jp',
  folderName: '議事録アプリ',
  segmentMinutes: 15,
  maxMinutes: 90
};
