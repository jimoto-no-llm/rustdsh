import React, {useEffect, useState} from 'react';
import {AbsoluteFill, Audio, Composition, Img, Sequence, continueRender, delayRender, interpolate, registerRoot, spring, staticFile, useCurrentFrame} from 'remotion';
import cli from '../public/cli.json';
import './style.css';

const FPS = 30;
const DURATION = 64 * FPS;
const blue = '#72b8ff';
const orange = '#ff9849';
const ink = '#f2f1ed';
const mut = '#939ba7';
const ease = (f: number, start = 0, duration = 22) => spring({fps: FPS, frame: f - start, config: {damping: 22, stiffness: 100}, durationInFrames: duration});
const map = (f: number, input: number[], output: number[]) => interpolate(f, input, output, {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

function Reveal({children, at = 0, style = {}}: {children: React.ReactNode; at?: number; style?: React.CSSProperties}) {
  const f = useCurrentFrame();
  const p = ease(f, at);
  return <div style={{opacity: p, transform: `translateY(${(1 - p) * 30}px)`, ...style}}>{children}</div>;
}

function Label({children}: {children: React.ReactNode}) {return <div className="label">{children}</div>;}
function Heading({children}: {children: React.ReactNode}) {return <h1>{children}</h1>;}
function Scene({children, length, caption, index}: {children: React.ReactNode; length: number; caption: string; index: string}) {
  const f = useCurrentFrame();
  const opacity = map(f, [0, 12, length - 12, length - 1], [0, 1, 1, 0]);
  return <AbsoluteFill style={{opacity}}>
    <div className="scene-number">{index} <span>/ RDSH</span></div>
    {children}
    <div className="caption"><span className="caption-dot"/>{caption}</div>
  </AbsoluteFill>;
}
function Screenshot({name, width, style = {}}: {name: string; width: number; style?: React.CSSProperties}) {
  return <Img src={staticFile(name)} style={{width, display: 'block', borderRadius: 20, boxShadow: '0 24px 80px #0005', ...style}}/>;
}
function BrowserBar({title = 'rdsh · demo'}: {title?: string}) {
  return <div className="browser-bar"><span/><span/><span/><div>{title}</div><small>DEMO DATA</small></div>;
}
function Pointer({x, y, click = false}: {x: number; y: number; click?: boolean}) {
  return <div style={{position: 'absolute', left: x, top: y}}>
    {click && <div style={{position: 'absolute', width: 76, height: 76, left: -28, top: -26, border: `3px solid ${blue}`, borderRadius: '50%', background: '#72b8ff22'}}/>}
    <svg width="38" height="44" viewBox="0 0 32 38"><path d="M3 2L4 30L12 22L18 35L24 32L18 20L29 19Z" fill="white" stroke="#172331" strokeWidth="2"/></svg>
  </div>;
}

function Hero() {
  const f = useCurrentFrame();
  return <Scene length={210} index="01" caption="いつものDSHに、Rustの速さと見通しを。">
    <div className="hero-orbit" style={{transform: `translate(-50%,-50%) rotate(${f * .08}deg)`}}/>
    <Reveal style={{position: 'absolute', left: 164, top: 200}}><Label>RUST × DEEPSEEK HARNESS</Label><div className="wordmark">rdsh<span>.</span></div></Reveal>
    <Reveal at={12} style={{position: 'absolute', left: 176, top: 528}}><div className="hero-title">軽く始める。<br/>状況が見える。</div></Reveal>
    <Reveal at={28} style={{position: 'absolute', left: 180, top: 780, display: 'flex', gap: 22}}>{['Rust CLI', 'DSH互換', 'Dashboard'].map(s => <div className="pill" key={s}>{s}</div>)}</Reveal>
    <Reveal at={8} style={{position: 'absolute', right: 172, top: 262}}><Img src={staticFile('icon.png')} style={{width: 420, height: 420, transform: `translateY(${Math.sin(f / 40) * 10}px)`, filter: 'drop-shadow(0 30px 55px #0005)'}}/></Reveal>
    <div style={{position: 'absolute', right: 252, top: 770, fontSize: 22, color: mut, letterSpacing: 4}}>FAST START. CLEAR VIEW.</div>
  </Scene>;
}

function CliScene() {
  const f = useCurrentFrame();
  const commands = [
    {at: 12, command: 'rdsh --version', result: cli.version},
    {at: 72, command: 'rdsh search TODO --dir .', result: cli.search},
    {at: 134, command: 'rdsh tokens README.md', result: cli.tokens},
  ];
  return <Scene length={270} index="02" caption="検索やトークン見積もりはRustで。会話は本家DSHへ委譲。">
    <Reveal style={{position: 'absolute', left: 104, top: 152, width: 590}}><Label>NATIVE COMMANDS</Label><Heading>使い方は、<br/>いつものCLI。</Heading><p>検索も、トークンの見積もりも。<br/>必要な処理をすばやく。</p><div className="code-pill">rdsh tui <span>→ DSH</span></div><div className="footnote">会話には本家DSHとモデル接続が必要です。</div></Reveal>
    <Reveal at={8} style={{position: 'absolute', left: 756, top: 188, width: 1060}}><div className="terminal"><BrowserBar title="rdsh-demo / terminal"/><div style={{padding: '38px 40px', height: 570}}>{commands.map(({at, command, result}) => <div key={command} style={{marginBottom: 40, opacity: map(f, [at, at + 8], [0, 1])}}><div className="terminal-command"><span>$ </span>{command.slice(0, Math.floor(map(f, [at, at + 29], [0, command.length])))}<span style={{opacity: f >= at && f < at + 30 && f % 20 < 10 ? 1 : 0}}>▋</span></div><div className="terminal-result" style={{opacity: map(f, [at + 33, at + 39], [0, 1])}}>{result}</div></div>)}</div></div></Reveal>
    <div className="screen-note" style={{left: 786, top: 836}}>実際のCLI出力 · 架空のREADMEで実行</div>
  </Scene>;
}

function Performance() {
  const f = useCurrentFrame();
  return <Scene length={240} index="03" caption="短いCLI起動を、軽く。Linuxの測定条件で比較しています。">
    <Reveal style={{position: 'absolute', left: 104, top: 146}}><Label>FAST START</Label><Heading>起動の待ち時間を、<br/>小さく。</Heading></Reveal>
    <Reveal at={12} style={{position: 'absolute', left: 1090, top: 158}}><div className="giant-stat">約98<span>倍</span></div><div style={{fontSize: 32, color: mut}}>速い起動</div></Reveal>
    <div style={{position: 'absolute', left: 112, top: 486, width: 1680}}>
      {[{name: 'dsh', value: '約88 ms', width: 1280, color: '#495365'}, {name: 'rdsh', value: '約0.90 ms', width: 22, color: blue}].map((r, i) => <div key={r.name} style={{display: 'flex', alignItems: 'center', height: 110, gap: 38}}><span style={{width: 114, fontSize: 34, fontFamily: 'Latin'}}>{r.name}</span><div style={{width: r.width * ease(f, 26 + i * 9, 38), height: 38, borderRadius: 8, background: r.color}}/><span style={{fontSize: 30, whiteSpace: 'nowrap', color: i ? blue : mut, opacity: ease(f, 62)}}>{r.value}</span></div>)}
    </div>
    <Reveal at={56} style={{position: 'absolute', left: 112, top: 745}}><div style={{fontSize: 34}}>最大RSS <span style={{color: blue}}>約2.9 MB</span> <span style={{color: mut, fontSize: 26}}>（本家 約66 MB）</span></div></Reveal>
    <div className="footnote" style={{position: 'absolute', left: 112, top: 837, marginTop: 0}}>READMEの測定値 · Linux x86_64 · --version · 起動中央値 n=5<br/>Desktop全体のメモリやモデル応答速度を表す数値ではありません。</div>
  </Scene>;
}

function Setup() {
  const f = useCurrentFrame();
  return <Scene length={270} index="04" caption="モデル接続と追加機能を、設定画面から。">
    <Reveal style={{position: 'absolute', left: 104, top: 206, width: 780}}><Label>SETUP</Label><Heading>最初の一歩も、<br/>画面から。</Heading><p>モデルへの接続を確認。<br/>追加機能は、必要なものだけ。</p><div className="code-pill">rdsh setup --web</div></Reveal>
    <Reveal at={10} style={{position: 'absolute', left: 1096, top: 122}}><Screenshot name={f > 126 ? 'setup-on.png' : 'setup-off.png'} width={620}/></Reveal>
    {f > 50 && f < 178 && <Pointer x={map(f, [50, 110], [1720, 1414])} y={map(f, [50, 110], [690, 383])} click={f > 120 && f < 142}/>}
    <div className="screen-note" style={{left: 1102, top: 915}}>実際の設定UI · 未接続のデモ環境</div>
  </Scene>;
}

function Dashboard() {
  return <Scene length={300} index="05" caption="プロジェクト別に、タスクと報告された指標を一覧に。">
    <Reveal style={{position: 'absolute', left: 104, top: 142, width: 650}}><Label>PROJECT DASHBOARD</Label><Heading>進捗を、<br/>見渡せる。</Heading><p>タスクの状態。<br/>トークンや費用の報告。<br/>ひとつの画面で確認。</p><div className="footnote">未取得の指標は、未取得のまま表示します。<br/>画面の数値はすべてデモデータです。</div></Reveal>
    <Reveal at={12} style={{position: 'absolute', left: 794, top: 172}}><div className="screen-panel" style={{width: 1020}}><BrowserBar title="rdsh-demo / project"/><Screenshot name="project-tasks.png" width={1020} style={{borderRadius: 0, boxShadow: 'none'}}/><div style={{background: '#f7f7f4', padding: '16px 0'}}><Screenshot name="project-metrics.png" width={1020} style={{borderRadius: 0, boxShadow: 'none'}}/></div></div></Reveal>
    <div className="screen-note" style={{left: 820, top: 890}}>実際のダッシュボードUI · タスクと数値は架空</div>
  </Scene>;
}

function Reply() {
  const f = useCurrentFrame();
  const saved = f >= 161;
  return <Scene length={270} index="06" caption="質問にその場で回答。保存した回答は、履歴で確認できます。">
    <Reveal style={{position: 'absolute', left: 104, top: 144}}><Label>HUMAN FEEDBACK</Label><Heading>迷ったら、<br/>画面から回答。</Heading></Reveal>
    <Reveal at={12} style={{position: 'absolute', left: 770, top: 222}}><div className="screen-panel" style={{width: 1040, background: '#f7f7f4'}}><BrowserBar title="rdsh-demo / questions"/><div style={{padding: 20}}><Screenshot name={saved ? 'question-saved.png' : 'question-draft.png'} width={1000} style={{borderRadius: 12, boxShadow: 'none'}}/></div></div></Reveal>
    <div style={{position: 'absolute', left: 110, top: 635, display: 'flex', flexDirection: 'column', gap: 22}}>{['質問を読む', '方針を答える', '保存を確認する'].map((s, i) => <Reveal at={20 + i * 24} key={s}><div style={{fontSize: 30, color: i === 2 && saved ? blue : ink}}><span style={{display: 'inline-block', width: 58, color: mut, fontFamily: 'Latin'}}>0{i + 1}</span>{s}</div></Reveal>)}</div>
    {f > 80 && f < 170 && <Pointer x={map(f, [80, 148], [1520, 845])} y={map(f, [80, 148], [650, 509])} click={f > 149 && f < 163}/>}
    {saved && <Reveal at={161} style={{position: 'absolute', left: 786, top: 570}}><div className="saved-pill">✓ 回答を保存しました</div><p style={{fontSize: 26, color: mut}}>実際にブラウザーから送信し、保存を確認。</p></Reveal>}
    <div className="screen-note" style={{left: 798, top: 830}}>架空の質問と回答 · 保存を示すデモ</div>
  </Scene>;
}

function Mobile() {
  const f = useCurrentFrame();
  return <Scene length={210} index="07" caption="スマホの画面でも確認。接続にはTailscaleなどの設定が必要です。">
    <Reveal style={{position: 'absolute', left: 104, top: 218, width: 880}}><Label>MOBILE VIEW</Label><Heading>離れた場所からも、<br/>状況を確認。</Heading><p>スマホでも、進捗と質問へ。<br/>同じプロジェクトを開けます。</p><div className="pill" style={{display: 'inline-block', marginTop: 18}}>Tailscaleでプライベート接続</div><div className="footnote">映像は390 px幅での表示デモです。<br/>PCとスマホの接続設定が必要です。</div></Reveal>
    <Reveal at={8} style={{position: 'absolute', left: 1270, top: 76}}><div className="phone"><div className="phone-camera"/><Img src={staticFile(f > 100 ? 'project-mobile-question.png' : 'project-mobile.png')} style={{width: 390, height: 844, display: 'block', borderRadius: 28}}/></div></Reveal>
  </Scene>;
}

function End() {
  return <Scene length={150} index="08" caption="rdsh — 軽く始める。状況が見える。">
    <Reveal style={{position: 'absolute', top: 190, width: '100%', textAlign: 'center'}}><Img src={staticFile('icon.png')} style={{width: 164, height: 164}}/><div style={{fontFamily: 'Latin', fontWeight: 700, fontSize: 126, letterSpacing: -8, marginTop: 10}}>rdsh<span style={{color: orange}}>.</span></div><div style={{fontSize: 44, marginTop: 14}}>軽く始める。状況が見える。</div></Reveal>
    <Reveal at={18} style={{position: 'absolute', top: 678, width: '100%', textAlign: 'center'}}><div style={{fontFamily: 'Latin', fontSize: 32, color: blue}}>github.com/jimoto-no-llm/rustdsh</div><div style={{fontSize: 22, color: mut, marginTop: 52}}>独立したコミュニティプロジェクトです。<br/>DeepSeekおよびDeepSeek Harnessの公式プロジェクトではありません。</div></Reveal>
  </Scene>;
}

function Intro() {
  const f = useCurrentFrame();
  const [handle] = useState(() => delayRender('Local Japanese and Latin fonts'));
  useEffect(() => {Promise.all([document.fonts.load('24px Japanese'), document.fonts.load('24px Latin')]).then(() => continueRender(handle));}, [handle]);
  return <AbsoluteFill className="canvas">
    <div className="ambient" style={{transform: `translate(${Math.sin(f / 330) * 60}px,${Math.cos(f / 300) * 40}px)`}}/>
    <div className="grid"/>
    <div className="top-rule"/>
    <Sequence from={0} durationInFrames={210}><Hero/></Sequence>
    <Sequence from={210} durationInFrames={270}><CliScene/></Sequence>
    <Sequence from={480} durationInFrames={240}><Performance/></Sequence>
    <Sequence from={720} durationInFrames={270}><Setup/></Sequence>
    <Sequence from={990} durationInFrames={300}><Dashboard/></Sequence>
    <Sequence from={1290} durationInFrames={270}><Reply/></Sequence>
    <Sequence from={1560} durationInFrames={210}><Mobile/></Sequence>
    <Sequence from={1770} durationInFrames={150}><End/></Sequence>
    <div className="timeline" style={{width: `${f / (DURATION - 1) * 100}%`}}/>
    <Audio src={staticFile('soundtrack.wav')} volume={1}/>
  </AbsoluteFill>;
}

registerRoot(() => <Composition id="RdshIntro" component={Intro} width={1920} height={1080} fps={FPS} durationInFrames={DURATION}/>);
