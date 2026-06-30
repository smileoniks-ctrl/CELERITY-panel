const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..');
const SETUP_EJS_PATH = path.join(PROJECT_ROOT, 'views', 'setup.ejs');
const LOCALES_DIR = path.join(PROJECT_ROOT, 'src', 'locales');

function readEjsBody() {
    return fs.readFileSync(SETUP_EJS_PATH, 'utf8');
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

function assertLocaleHasSetupKeys(localeName) {
    const parsed = readLocale(localeName);
    assert.ok(parsed.setup, `${localeName}.json must define a "setup" object`);
    assert.ok(
        parsed.setup.usernameTooShort,
        `${localeName}.json must define "setup.usernameTooShort"`
    );
    assert.ok(
        parsed.setup.passwordTooShort,
        `${localeName}.json must define "setup.passwordTooShort"`
    );
    assert.ok(
        parsed.setup.passwordsMismatch,
        `${localeName}.json must define "setup.passwordsMismatch"`
    );
}

const ejsBody = readEjsBody();
const scriptBlock = extractScriptBlock(ejsBody);

assert.ok(
    /<input[\s\S]*?id="username"[\s\S]*?minlength="3"[\s\S]*?>/i.test(ejsBody),
    'setup.ejs must declare a username input with id="username" and minlength="3"'
);

assert.ok(
    /<input[\s\S]*?id="password"[\s\S]*?minlength="6"[\s\S]*?>/i.test(ejsBody),
    'setup.ejs must declare a password input with id="password" and minlength="6"'
);

assert.ok(
    /<input[\s\S]*?id="passwordConfirm"[\s\S]*?minlength="6"[\s\S]*?>/i.test(ejsBody),
    'setup.ejs must declare a passwordConfirm input with id="passwordConfirm" and minlength="6"'
);

assert.ok(
    scriptBlock.includes('setCustomValidity'),
    'setup.ejs <script> block must call setCustomValidity for client-side validation'
);

assert.ok(
    scriptBlock.includes('setup.usernameTooShort'),
    'setup.ejs <script> block must reference the i18n key "setup.usernameTooShort"'
);

assert.ok(
    scriptBlock.includes('setup.passwordTooShort'),
    'setup.ejs <script> block must reference the i18n key "setup.passwordTooShort"'
);

assert.ok(
    scriptBlock.includes('setup.passwordsMismatch'),
    'setup.ejs <script> block must reference the i18n key "setup.passwordsMismatch"'
);

assert.ok(
    /addEventListener\(\s*['"]input['"]/i.test(scriptBlock),
    'setup.ejs <script> block must attach at least one addEventListener("input", ...) listener'
);

assert.ok(
    scriptBlock.includes("getElementById('username')") ||
        scriptBlock.includes('getElementById("username")'),
    'setup.ejs <script> block must look up the #username input via getElementById'
);

assert.ok(
    scriptBlock.includes("getElementById('password')") ||
        scriptBlock.includes('getElementById("password")'),
    'setup.ejs <script> block must look up the #password input via getElementById'
);

assert.ok(
    scriptBlock.includes("getElementById('passwordConfirm')") ||
        scriptBlock.includes('getElementById("passwordConfirm")'),
    'setup.ejs <script> block must look up the #passwordConfirm input via getElementById'
);

assertLocaleHasSetupKeys('en');
assertLocaleHasSetupKeys('ru');
assertLocaleHasSetupKeys('zh-CN');

console.log('setup EJS validation tests passed');
process.exit(0);
