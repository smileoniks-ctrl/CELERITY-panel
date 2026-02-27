/**
 * Russian translations for the OpenAPI spec.
 * Only overrides: info.description, tags[].description, and paths operation summaries/descriptions.
 * Merged on top of the base English spec by buildSpec(lang).
 */

module.exports = {
    ru: {
        info: {
            description: `
Управляющий API для [C³ CELERITY](https://github.com/ClickDevTech/hysteria-panel) — панели Hysteria 2 от Click Connect.

## Аутентификация

Все эндпоинты \`/api/*\` (кроме \`/api/auth\` и \`/api/files\`) требуют аутентификации через **API-ключ**.

Создать ключ: **Панель → Настройки → Безопасность → API-ключи**

\`\`\`
X-API-Key: ck_your_key_here
\`\`\`
или
\`\`\`
Authorization: Bearer ck_your_key_here
\`\`\`

## Скоупы

| Скоуп | Доступ |
|-------|--------|
| \`users:read\` | Чтение пользователей |
| \`users:write\` | Создание / изменение / удаление пользователей |
| \`nodes:read\` | Чтение нод |
| \`nodes:write\` | Создание / изменение / удаление / синхронизация нод |
| \`stats:read\` | Статистика и группы |
| \`sync:write\` | Запуск синхронизации, кик пользователей |

Сессии администратора (cookie) полностью обходят проверку скоупов.
            `.trim(),
        },
        tags: [
            { name: 'Stats',  description: 'Статистика панели и группы серверов' },
            { name: 'Users',  description: 'Управление пользователями — скоуп: `users:read` / `users:write`' },
            { name: 'Nodes',  description: 'Управление нодами — скоуп: `nodes:read` / `nodes:write`' },
            { name: 'Sync',   description: 'Синхронизация и кик пользователей — скоуп: `sync:write`' },
            { name: 'Public', description: 'Публичные эндпоинты — аутентификация не требуется' },
        ],
        operations: {
            'POST /auth': {
                summary: 'Проверить пользователя при подключении',
                description: 'Вызывается нодами Hysteria для аутентификации клиентов. API-ключ не требуется.',
            },
            'GET /files/{token}': {
                summary: 'Получить конфиг подписки',
                description: 'Автоматически определяет формат по User-Agent. Возвращает Clash YAML, Sing-box JSON или URI-список.',
            },
            'GET /info/{token}': {
                summary: 'Получить информацию о подписке',
                description: 'Возвращает использование трафика и дату истечения.',
            },
            'GET /stats': {
                summary: 'Статистика панели',
                description: 'Возвращает общее количество пользователей, нод и текущих подключений.',
            },
            'GET /groups': {
                summary: 'Список групп серверов',
                description: '',
            },
            'GET /users': {
                summary: 'Список пользователей',
                description: 'Поддерживает пагинацию, фильтрацию и сортировку.',
            },
            'POST /users': {
                summary: 'Создать пользователя',
                description: '',
            },
            'GET /users/{userId}': {
                summary: 'Получить пользователя по ID',
                description: '',
            },
            'PUT /users/{userId}': {
                summary: 'Обновить пользователя',
                description: '',
            },
            'DELETE /users/{userId}': {
                summary: 'Удалить пользователя',
                description: '',
            },
            'POST /users/{userId}/enable': {
                summary: 'Включить пользователя',
                description: '',
            },
            'POST /users/{userId}/disable': {
                summary: 'Отключить пользователя',
                description: '',
            },
            'POST /users/{userId}/groups': {
                summary: 'Добавить пользователя в группы',
                description: '',
            },
            'DELETE /users/{userId}/groups/{groupId}': {
                summary: 'Удалить пользователя из группы',
                description: '',
            },
            'GET /nodes': {
                summary: 'Список нод',
                description: '',
            },
            'POST /nodes': {
                summary: 'Создать ноду',
                description: '',
            },
            'GET /nodes/{id}': {
                summary: 'Получить ноду по ID',
                description: '',
            },
            'PUT /nodes/{id}': {
                summary: 'Обновить ноду',
                description: '',
            },
            'DELETE /nodes/{id}': {
                summary: 'Удалить ноду',
                description: '',
            },
            'GET /nodes/{id}/status': {
                summary: 'Получить живой статус ноды',
                description: 'Запрашивает Stats API ноды напрямую для получения текущего онлайна.',
            },
            'POST /nodes/{id}/sync': {
                summary: 'Синхронизировать конкретную ноду',
                description: 'Отправляет актуальный конфиг на ноду через SSH.',
            },
            'GET /nodes/{id}/config': {
                summary: 'Получить сгенерированный конфиг ноды',
                description: 'Возвращает YAML-конфиг, который будет применён к ноде.',
            },
            'GET /nodes/{id}/users': {
                summary: 'Список пользователей на ноде',
                description: '',
            },
            'POST /sync': {
                summary: 'Синхронизировать все ноды',
                description: 'Отправляет конфиг на все активные ноды параллельно. Возвращает ответ немедленно — синхронизация идёт в фоне.',
            },
            'POST /kick/{userId}': {
                summary: 'Кикнуть пользователя со всех нод',
                description: 'Принудительно отключает пользователя от всех нод Hysteria.',
            },
        },
    },
};
