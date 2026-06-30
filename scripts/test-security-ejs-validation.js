const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..');
const SECURITY_EJS_PATH = path.join(PROJECT_ROOT, 'views', 'partials', 'settings', 'security.ejs');
const LOCALES_DIR = path.join(PROJECT_ROOT, 'src', 'locales');

function readSecurityEjsBody() {
    return fs.readFileSync(SECURITY_EJS_PATH, 'utf8');
}

function extractScriptBlock(body) {
    const matches = body.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || [];
    return matches.join('\n');
}

function readLocale(localeName) {
    const filePath = path.join(LOCALES_DIR, `${localeName}.json`);
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
}

function assertLocaleHasPasswordKeys(localeName) {
    const parsed = readLocale(localeName);
    assert.ok(parsed.settings, `${localeName}.json must define a "settings" object`);
    assert.ok(
        parsed.settings.newPasswordTooShort,
        `${localeName}.json must define "settings.newPasswordTooShort"`
    );
    assert.ok(parsed.setup, `${localeName}.json must define a "setup" object`);
    assert.ok(
        parsed.setup.passwordsMismatch,
        `${localeName}.json must define "setup.passwordsMismatch"`
    );
}

const ejsBody = readSecurityEjsBody();
const scriptBlock = extractScriptBlock(ejsBody);

assert.ok(
    /<input[\s\S]*?name="newPassword"[\s\S]*?minlength="6"[\s\S]*?>/i.test(ejsBody),
    'security.ejs must declare a newPassword input with name="newPassword" and minlength="6"'
);

assert.ok(
    /<input[\s\S]*?name="confirmPassword"[\s\S]*?minlength="6"[\s\S]*?>/i.test(ejsBody),
    'security.ejs must declare a confirmPassword input with name="confirmPassword" and minlength="6"'
);

assert.ok(
    scriptBlock.length > 0,
    'security.ejs must contain at least one <script> block'
);

assert.ok(
    scriptBlock.includes('setCustomValidity'),
    'security.ejs <script> block must call setCustomValidity for client-side validation'
);

assert.ok(
    scriptBlock.includes('settings.newPasswordTooShort'),
    'security.ejs <script> block must reference the i18n key "settings.newPasswordTooShort"'
);

assert.ok(
    scriptBlock.includes('setup.passwordsMismatch'),
    'security.ejs <script> block must reference the i18n key "setup.passwordsMismatch"'
);

assert.ok(
    scriptBlock.includes('input[name="newPassword"]') ||
        scriptBlock.includes("input[name='newPassword']"),
    'security.ejs <script> block must query "input[name=\\"newPassword\\"]"'
);

assert.ok(
    scriptBlock.includes('input[name="confirmPassword"]') ||
        scriptBlock.includes("input[name='confirmPassword']"),
    'security.ejs <script> block must query "input[name=\\"confirmPassword\\"]"'
);

assert.ok(
    /addEventListener\(\s*['"]input['"]/i.test(scriptBlock),
    'security.ejs <script> block must attach at least one addEventListener("input", ...) listener'
);

assertLocaleHasPasswordKeys('en');
assertLocaleHasPasswordKeys('ru');
assertLocaleHasPasswordKeys('zh-CN');

console.log('security EJS validation tests passed');
process.exit(0);
