/* App identity, credits and who receives change requests. Edit here, then commit. */
(function () {
  const TC = (window.TC = window.TC || {});
  TC.config = {
    org: 'Pellera Technologies',
    appName: 'AI Token Calculator',
    copyright: '© 2026 Darren Livingston & Brad Ramsey – Pellera Technologies',
    // Change requests open an email to everyone listed here. Leave email blank to omit someone.
    contacts: [
      { name: 'Darren Livingston', email: 'darren.livingston@pellera.com' },
      { name: 'Brad Ramsey', email: 'brad.ramsey@pellera.com' },
    ],
    requestSubjectPrefix: '[AI Token Calculator]',
    pptxLib: 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js',
  };
})();
