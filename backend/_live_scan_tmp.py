import app.main as M
from fastapi.routing import APIRoute

def perms_of(dependant, seen=None):
    out=set()
    for d in dependant.dependencies:
        c=d.call
        if getattr(c,"__name__","")=="checker" and getattr(c,"__closure__",None):
            for cell in c.__closure__:
                v=cell.cell_contents
                if isinstance(v,str): out.add(v)
        out |= perms_of(d, seen)
    return out

rows=[]
for r in M.app.routes:
    if not isinstance(r,APIRoute): continue
    p=perms_of(r.dependant)
    rows.append((sorted(r.methods-{"HEAD","OPTIONS"}), r.path, r.endpoint.__module__, r.name, p))
ung=[x for x in rows if not x[4]]
print(f"TOTAL {len(rows)}  UNGUARDED {len(ung)}")
cur=None
for m,path,mod,name,p in sorted(ung,key=lambda x:(x[2],x[1])):
    if mod!=cur: cur=mod; print("\n### "+cur)
    print(f"  {','.join(m):<7} {path:<55} {name}")
