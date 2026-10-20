import json, collections, sys
p="/tmp/dsh-prof/CPU.20261020.202909.585109.0.001.cpuprofile"
d=json.load(open(p))
nodes={n["id"]:n for n in d["nodes"]}
# self time from samples/timeDeltas
self=collections.Counter()
total=0
samples=d["samples"]; deltas=d["timeDeltas"]
for i,s in enumerate(samples):
    dt=deltas[i] if i<len(deltas) else 0
    self[s]+=dt; total+=dt
print("total sampled us: %d (%.2f s)"%(total,total/1e6))
print("samples:",len(samples))
def cf(n):
    return n.get("callFrame",{})
print()
print("=== TOP 25 SELF TIME ===")
for nid,us in self.most_common(25):
    f=cf(nodes.get(nid,{}))
    url=f.get("url","")
    print("%9.1f ms %5.1f%%  %s  (%s)"%(us/1000, us/total*100, f.get("functionName","?"), url.split("/")[-1][:60]))
print()
print("=== by URL bucket ===")
b=collections.Counter()
for nid,us in self.items():
    u=cf(nodes.get(nid,{})).get("url","") or "?"
    if u=="?": k="(native/idle)"
    elif "node:" in u or u.startswith("internal/"): k="node-internal"
    elif "@deepseek-ai/dsh" in u: k="@dsh/dsh"
    elif "/dsh/" in u: k="@dsh/dsh"
    elif "node_modules" in u: k="other-node_modules"
    else: k="other"
    b[k]+=us
for k,v in b.most_common():
    print("%9.1f ms %5.1f%%  %s"%(v/1000,v/total*100,k))
