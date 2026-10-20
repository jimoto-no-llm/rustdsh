import json, collections
p="/tmp/dsh-prof/CPU.20261020.202909.585109.0.001.cpuprofile"
d=json.load(open(p))
urls=set(); pkgs=set()
for n in d["nodes"]:
    u=n.get("callFrame",{}).get("url","")
    if u.startswith("file://"):
        urls.add(u)
        path=u[7:]
        if "node_modules" in path:
            parts=path.split("node_modules/")
            if len(parts)>1:
                seg=parts[-1].split("/")
                pkgs.add(seg[0]+"/"+seg[1] if seg[0].startswith("@") and len(seg)>1 else seg[0])
print("distinct file:// modules loaded:", len(urls))
print("distinct packages:", len(pkgs))
print()
print("=== top 25 packages by file count ===")
c=collections.Counter()
for u in urls:
    path=u[7:]
    if "node_modules" in path:
        seg=path.split("node_modules/")[-1].split("/")
        c[seg[0]+"/"+seg[1] if seg[0].startswith("@") and len(seg)>1 else seg[0]]+=1
for k,v in c.most_common(25): print("%4d %s"%(v,k))
