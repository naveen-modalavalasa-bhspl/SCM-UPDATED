import os, glob, re

def check_routers():
    router_files = glob.glob("backend/app/modules/**/router.py", recursive=True) + \
                   glob.glob("backend/app/platform/**/router.py", recursive=True)
    
    unprotected = []
    for fpath in router_files:
        with open(fpath, "r", encoding="utf-8") as f:
            content = f.read()
        
        # split by @router. or @<name>_router.
        endpoints = re.split(r'\n\s*@\w+?_?router\.(get|post|put|delete|patch)', content)
        for i in range(1, len(endpoints), 2):
            method = endpoints[i]
            body = endpoints[i+1]
            func_match = re.search(r'async def (\w+)\((.*?)\):', body, re.DOTALL)
            if func_match:
                fname = func_match.group(1)
                params = func_match.group(2)
                if "require_permission" not in params and "get_current_user" not in params:
                    unprotected.append((fpath, method, fname))

    print(f"Total unprotected endpoints found: {len(unprotected)}")
    for fpath, method, fname in unprotected[:30]:
        print(f"  [{method.upper()}] {fname} in {fpath}")

check_routers()
