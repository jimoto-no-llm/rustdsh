import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const discovery=spawnSync('git',['rev-parse','--absolute-git-dir'],{encoding:'utf8'});
if(discovery.status!==0)throw new Error(discovery.stderr);
const repo=discovery.stdout.trim();
function source(revision) {
  const result=spawnSync('git',[`--git-dir=${repo}`,'show',`${revision}:src/websearch.rs`],{encoding:'utf8'});
  if(result.status!==0)throw new Error(result.stderr);
  const start=result.stdout.indexOf('fn encode_query('),marker=result.stdout.indexOf('\n}\n',start+3);
  if(start<0||marker<0)throw new Error('Missing query function');
  const end=marker+3;
  return result.stdout.slice(start,end)+'\n';
}
const baseline='96dbcbbd6e1295b2e92ba31e9cf9037770107b24',candidate='19c4a6d0d42b37ac7079d7cf0ac92ca52bb99b24';
const directory=mkdtempSync(path.join(os.tmpdir(),'rdsh-query-bench-'));
const program=String.raw`
mod before { ${source(baseline)} pub fn run(s:&str)->String {encode_query(s)} }
mod after { use std::fmt::Write as _; ${source(candidate)} pub fn run(s:&str)->String {encode_query(s)} }
#[cfg(count_allocations)] mod allocation {
  use std::alloc::{GlobalAlloc,Layout,System};
  use std::sync::atomic::{AtomicUsize,Ordering};
  pub static COUNT:AtomicUsize=AtomicUsize::new(0);
  pub struct Counting;
  unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self,l:Layout)->*mut u8 {COUNT.fetch_add(1,Ordering::Relaxed);System.alloc(l)}
    unsafe fn dealloc(&self,p:*mut u8,l:Layout){System.dealloc(p,l)}
    unsafe fn realloc(&self,p:*mut u8,l:Layout,n:usize)->*mut u8 {COUNT.fetch_add(1,Ordering::Relaxed);System.realloc(p,l,n)}
  }
}
#[cfg(count_allocations)] #[global_allocator] static ALLOC:allocation::Counting=allocation::Counting;
fn sample(run:fn(&str)->String)->f64 {
  let start=std::time::Instant::now();
  for _ in 0..10000 {std::hint::black_box(run(std::hint::black_box("日本語 Rust&CLI? 100%")));}
  start.elapsed().as_secs_f64()*1000.0
}
fn main() {
  for value in ["ascii query","日本語 Rust&CLI? 100%","hello\r\nInjected: yes","emoji🐱","nul\0 tab\t"] {
    assert_eq!(before::run(value),after::run(value));
  }
  #[cfg(count_allocations)] {
    use std::sync::atomic::Ordering;
    allocation::COUNT.store(0,Ordering::Relaxed);
    let first=before::run(std::hint::black_box("日本語 Rust&CLI? 100%"));
    let a=allocation::COUNT.load(Ordering::Relaxed);
    allocation::COUNT.store(0,Ordering::Relaxed);
    let second=after::run(std::hint::black_box("日本語 Rust&CLI? 100%"));
    let b=allocation::COUNT.load(Ordering::Relaxed);
    assert_eq!(first,second);
    println!("{{\"before\":{a},\"after\":{b}}}");
    return;
  }
  #[cfg(not(count_allocations))] {
    for _ in 0..5 {sample(before::run);sample(after::run);}
    let mut a=Vec::new();let mut b=Vec::new();
    for i in 0..30 {if i%2==0 {a.push(sample(before::run));b.push(sample(after::run));} else {b.push(sample(after::run));a.push(sample(before::run));}}
    println!("{{\"before\":{:?},\"after\":{:?}}}",a,b);
  }
}
`;
const input=path.join(directory,'bench.rs');writeFileSync(input,program);
const results={baseline,candidate,os:os.release(),cpu:os.cpus()[0]?.model,warmups:5,samples:30,iterationsPerSample:10000,input:'日本語 Rust&CLI? 100%',outputEquality:'ASCII, Japanese, CRLF, emoji, NUL/tab passed',method:'Exact query functions extracted from each commit; uninstrumented -O timing and a separately compiled allocation counter'};
for(const [name,args] of [['timing',[]],['allocations',['--cfg','count_allocations']]]) {
  const binary=path.join(directory,name);
  const compiled=spawnSync('rustc',['-O','--edition=2021',...args,input,'-o',binary],{encoding:'utf8'});
  if(compiled.status!==0)throw new Error(compiled.stderr);
  const run=spawnSync(binary,[],{encoding:'utf8'});if(run.status!==0)throw new Error(run.stderr);
  results[name]=JSON.parse(run.stdout);
}
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return (sorted[14]+sorted[15])/2;};
results.medianMsPer10000={before:median(results.timing.before),after:median(results.timing.after)};
writeFileSync(process.argv[2],JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify({medianMsPer10000:results.medianMsPer10000,allocations:results.allocations}));
