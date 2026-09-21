import re
import os

files = [
    'backend/app/modules/warehouse/enums.py',
    'backend/app/modules/warehouse/service.py',
    'frontend/src/modules/approvals/docTypes.ts',
    'frontend/src/modules/procurement/components/LinePicker.tsx',
    'frontend/src/modules/procurement/pages/PODetailPage.tsx',
    'frontend/src/modules/rbac/pages/JobProfilesPage.tsx',
    'frontend/src/modules/warehouse/api.ts',
    'frontend/src/modules/warehouse/components/LinesEditor.tsx',
    'frontend/src/modules/warehouse/format.ts',
    'frontend/src/modules/warehouse/pages/MaterialIssueForm.tsx',
    'frontend/src/modules/warehouse/pages/StockMovementDetail.tsx',
    'frontend/src/modules/warehouse/pages/StockMovementForm.tsx',
    'frontend/src/modules/warehouse/tests/format.test.ts'
]

pattern = re.compile(r'<<<<<<< HEAD\n(.*?)\n=======\n(.*?)\n>>>>>>> [a-f0-9]+', re.DOTALL)

for fpath in files:
    if not os.path.exists(fpath):
        continue
    with open(fpath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    if fpath == 'backend/app/modules/warehouse/service.py':
        # Custom logic for service.py
        def repl_service(m):
            head_content = m.group(1)
            qa_content = m.group(2)
            if '_perform_movement_order' in head_content:
                return head_content
            else:
                return qa_content
        new_content = pattern.sub(repl_service, content)
    else:
        # Default: pick QA (theirs)
        def repl_default(m):
            return m.group(2)
        new_content = pattern.sub(repl_default, content)
        
    with open(fpath, 'w', encoding='utf-8', newline='') as f:
        f.write(new_content)
        
print('Conflicts resolved programmatically.')
