// src/host/launcher/ui-templates.ts

export function generateLauncherUI(): string {
  return `
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <title>مدير البرامج - نواة نوات</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background-color: #f8fafc;
          color: #1e293b;
        }
        
        .launcher-container {
          display: grid;
          grid-template-columns: 280px 1fr;
          height: 100vh;
        }
        
        /* الشريط الجانبي - ثيم فاتح ناصع */
        .sidebar {
          background-color: #ffffff;
          padding: 24px 20px;
          border-left: 1px solid #e2e8f0;
          box-shadow: 1px 0 3px rgba(0,0,0,0.02);
        }
        
        .sidebar h2 {
          color: #2563eb;
          margin-bottom: 20px;
          font-size: 1.1em;
          font-weight: 700;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        
        .program-list {
          list-style: none;
        }
        
        .program-item {
          padding: 12px 14px;
          margin: 8px 0;
          background-color: #f1f5f9;
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s ease;
          display: flex;
          align-items: center;
          gap: 12px;
          color: #334155;
        }
        
        .program-item:hover {
          background-color: #e2e8f0;
          border-color: #cbd5e1;
          color: #0f172a;
        }

        .program-item.selected {
          background-color: #eff6ff;
          border-color: #93c5fd;
          color: #1d4ed8;
          font-weight: 600;
        }
        
        .program-item .icon {
          font-size: 1.3em;
        }
        
        .program-item .status {
          margin-right: auto;
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background-color: #10b981;
        }
        
        .program-item .status.stopped {
          background-color: #cbd5e1;
        }
        
        /* المنطقة الرئيسية - ثيم فاتح */
        .main-area {
          display: flex;
          flex-direction: column;
          background-color: #f8fafc;
        }
        
        .toolbar {
          background-color: #ffffff;
          padding: 12px 24px;
          display: flex;
          gap: 12px;
          border-bottom: 1px solid #e2e8f0;
        }
        
        .toolbar button {
          background-color: #f1f5f9;
          color: #334155;
          border: 1px solid #cbd5e1;
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 0.9em;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s ease;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        
        .toolbar button:hover {
          background-color: #2563eb;
          color: #ffffff;
          border-color: #2563eb;
        }
        
        .toolbar button.danger {
          color: #dc2626;
          border-color: #fca5a5;
          background-color: #fef2f2;
        }

        .toolbar button.danger:hover {
          background-color: #dc2626;
          color: #ffffff;
          border-color: #dc2626;
        }
        
        /* منطقة التضمين */
        .embed-area {
          flex: 1;
          background-color: #ffffff;
          margin: 16px;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          position: relative;
          overflow: hidden;
          box-shadow: 0 1px 3px rgba(0,0,0,0.03);
        }
        
        .embed-container {
          width: 100%;
          height: 100%;
          border: none;
        }
        
        .embed-container iframe {
          width: 100%;
          height: 100%;
          border: none;
          background-color: #ffffff;
        }

        .placeholder {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: #64748b;
          gap: 12px;
        }

        .placeholder-icon {
          width: 48px;
          height: 48px;
          background-color: #f1f5f9;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #94a3b8;
          font-size: 24px;
        }
        
        /* شريط الحالة */
        .status-bar {
          background-color: #ffffff;
          padding: 10px 24px;
          font-size: 0.85em;
          color: #64748b;
          display: flex;
          justify-content: space-between;
          border-top: 1px solid #e2e8f0;
        }
      </style>
    </head>
    <body>
      <div class="launcher-container">
        <!-- الشريط الجانبي -->
        <div class="sidebar">
          <h2>🚀 البرامج المثبتة</h2>
          <ul class="program-list" id="programList">
            <!-- يتم ملؤها ديناميكياً -->
          </ul>
        </div>
        
        <!-- المنطقة الرئيسية -->
        <div class="main-area">
          <div class="toolbar">
            <button onclick="launchSelected()">▶️ تشغيل</button>
            <button onclick="embedSelected()">📌 تضمين</button>
            <button onclick="stopSelected()" class="danger">⏹️ إيقاف</button>
            <button onclick="refreshList()">🔄 تحديث</button>
          </div>
          
          <div class="embed-area" id="embedArea">
            <!-- يتم عرض البرامج المضمنة هنا -->
            <div class="placeholder">
              <div class="placeholder-icon">🖥️</div>
              <p>اختر برنامجاً من القائمة لتشغيله أو تضمينه داخل الواجهة</p>
            </div>
          </div>
          
          <div class="status-bar">
            <span id="statusText">النظام جاهز</span>
            <span id="processCount">0 عملية نشطة</span>
          </div>
        </div>
      </div>

      <script>
        const API_BASE = '/api/launcher';
        
        async function loadPrograms() {
          try {
            const response = await fetch(API_BASE + '/programs');
            if (response.ok) {
              const programs = await response.json();
              renderProgramList(programs);
            }
          } catch (e) {
            console.log('Launcher API status check');
          }
        }
        
        function renderProgramList(programs) {
          const list = document.getElementById('programList');
          if (!programs || !programs.length) return;
          list.innerHTML = programs.map(p => \`
            <li class="program-item" data-id="\${p.id}" onclick="selectProgram('\${p.id}')">
              <span class="icon">\${p.icon || '📦'}</span>
              <span>\${p.name}</span>
              <span class="status \${p.running ? '' : 'stopped'}"></span>
            </li>
          \`).join('');
        }
        
        async function launchSelected() {
          const selected = document.querySelector('.program-item.selected');
          if (!selected) return;
          
          const programId = selected.dataset.id;
          try {
            const response = await fetch(API_BASE + '/launch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ programId, mode: 'managed' })
            });
            const result = await response.json();
            updateStatus(\`تم تشغيل \${programId} (PID: \${result.pid || 'جديد'})\`);
          } catch (e) {
            updateStatus('تعذر الاتصال بـ API التشغيل');
          }
        }
        
        async function embedSelected() {
          const selected = document.querySelector('.program-item.selected');
          if (!selected) return;
          
          const programId = selected.dataset.id;
          const embedArea = document.getElementById('embedArea');
          
          try {
            const response = await fetch(API_BASE + '/embed', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                programId,
                containerId: 'embed-' + Date.now()
              })
            });
            
            const result = await response.json();
            if (result.embedHtml) {
              embedArea.innerHTML = result.embedHtml;
            }
          } catch (e) {
            updateStatus('تعذر الاتصال بخدمة التضمين');
          }
        }
        
        function selectProgram(id) {
          document.querySelectorAll('.program-item').forEach(el => 
            el.classList.remove('selected')
          );
          document.querySelector(\`[data-id="\${id}"]\`)?.classList.add('selected');
        }

        function refreshList() {
          loadPrograms();
        }
        
        function updateStatus(text) {
          const statusEl = document.getElementById('statusText');
          if (statusEl) statusEl.textContent = text;
        }
        
        loadPrograms();
      </script>
    </body>
    </html>
  `;
}
