# C³ CELERITY

⚡ **Быстро, просто и надолго**

[English](README.md) | **[Русский](README.ru.md)**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker Pulls](https://img.shields.io/docker/pulls/clickdevtech/hysteria-panel)](https://hub.docker.com/r/clickdevtech/hysteria-panel)
[![Docker Image Size](https://img.shields.io/docker/image-size/clickdevtech/hysteria-panel/latest)](https://hub.docker.com/r/clickdevtech/hysteria-panel)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](package.json)
[![Hysteria](https://img.shields.io/badge/Hysteria-2.x-9B59B6)](https://v2.hysteria.network/)

**C³ CELERITY** by Click Connect — современная веб-панель для управления серверами [Hysteria 2](https://v2.hysteria.network/) с централизованной HTTP-авторизацией, автоматической настройкой нод и гибким распределением пользователей по группам.

<p align="center">
  <img src="https://github.com/user-attachments/assets/bc04b654-aad1-4dc7-96fb-3f35df114eaf" alt="C³ CELERITY Dashboard" width="800">
  <br>
  <em>Дашборд — мониторинг серверов и статистика в реальном времени</em>
</p>

## ⚡ Быстрый старт

**1. Установите Docker** (если не установлен):
```bash
curl -fsSL https://get.docker.com | sh
```

**2. Разверните панель (Docker Hub — рекомендуется):**
```bash
mkdir hysteria-panel && cd hysteria-panel

# Скачать необходимые файлы
curl -O https://raw.githubusercontent.com/ClickDevTech/hysteria-panel/main/docker-compose.hub.yml
curl -O https://raw.githubusercontent.com/ClickDevTech/hysteria-panel/main/docker.env.example

cp docker.env.example .env
nano .env  # Укажите домен, email и секреты
docker compose -f docker-compose.hub.yml up -d
```

**Альтернатива: сборка из исходников** (для разработки или кастомизации)
```bash
git clone https://github.com/ClickDevTech/hysteria-panel.git
cd hysteria-panel
cp docker.env.example .env
nano .env  # Укажите домен, email и секреты
docker compose up -d
```

**3. Откройте** `https://ваш-домен/panel`

**Обязательные переменные `.env`:**
```env
PANEL_DOMAIN=panel.example.com
ACME_EMAIL=admin@example.com
ENCRYPTION_KEY=ваш32символьныйключ  # openssl rand -hex 16
SESSION_SECRET=секретсессий         # openssl rand -hex 32
MONGO_PASSWORD=парольмонго         # openssl rand -hex 16
```

---

## ✨ Возможности

- 🖥 **Веб-панель** — полноценный UI для управления нодами и пользователями
- 🔐 **HTTP-авторизация** — централизованная проверка клиентов через API
- 🚀 **Автонастройка нод** — установка Hysteria, сертификатов и port hopping в один клик
- 👥 **Группы серверов** — гибкая привязка пользователей к нодам
- ⚖️ **Балансировка нагрузки** — распределение по загруженности
- 🚫 **Фильтрация трафика (ACL)** — блокировка рекламы, доменов, IP; маршрутизация через прокси
- 📊 **Статистика** — онлайн, трафик, состояние серверов
- 📱 **Подписки** — автоформаты для Clash, Sing-box, Shadowrocket
- 🔄 **Бэкап/Восстановление** — автоматические бэкапы базы
- 💻 **SSH-терминал** — прямой доступ к нодам из браузера
- 🔑 **API-ключи** — безопасный внешний доступ со скоупами, IP-фильтром и rate limiting
- 🪝 **Вебхуки** — уведомления о событиях с подписью HMAC-SHA256

---

## 🏗 Архитектура

```
                              ┌─────────────────┐
                              │     КЛИЕНТЫ     │
                              │ Clash, Sing-box │
                              │   Shadowrocket  │
                              └────────┬────────┘
                                       │
                          hysteria2://user:pass@host
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
     ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
     │      Нода       │      │      Нода       │      │      Нода       │
     │   Hysteria 2    │      │   Hysteria 2    │      │   Hysteria 2    │
     │   :443 + hop    │      │   :443 + hop    │      │   :443 + hop    │
     └────────┬────────┘      └────────┬────────┘      └────────┬────────┘
              │                        │                        │
              │    POST /api/auth      │                        │
              │    GET /online         │                        │
              └────────────────────────┼────────────────────────┘
                                       ▼
                          ┌────────────────────────┐
                          │    HYSTERIA PANEL      │
                          │                        │
                          │  • Веб-панель (/panel) │
                          │  • HTTP Auth API       │
                          │  • Подписки            │
                          │  • SSH-терминал        │
                          │  • Сбор статистики     │
                          └───────────┬────────────┘
                                      │
                                      ▼
                          ┌────────────────────────┐
                          │       MongoDB          │
                          └────────────────────────┘
```

### Как работает авторизация

1. Клиент подключается к ноде Hysteria с `userId:password`
2. Нода отправляет `POST /api/auth` на панель
3. Панель проверяет: существует ли пользователь, активен ли, не превышен ли лимит устройств/трафика
4. Возвращает `{ "ok": true, "id": "userId" }` или `{ "ok": false }`

### Группы серверов

Вместо жёстких "планов" используются гибкие группы:
- Создайте группу (например, "Европа", "Premium")
- Привяжите к ней ноды
- Привяжите пользователей
- Пользователь получает в подписке только ноды из своих групп

---

## 📖 API

### Аутентификация через API-ключ

Все эндпоинты `/api/*` (кроме `/api/auth` и `/api/files`) требуют аутентификации — через API-ключ или cookie сессии администратора.

**Создать ключ:** Настройки → Безопасность → API-ключи → Создать ключ

**Использование:**
```http
# Вариант 1 — заголовок
X-API-Key: ck_your_key_here

# Вариант 2 — Bearer токен
Authorization: Bearer ck_your_key_here
```

#### Скоупы (права доступа)

| Скоуп | Доступ |
|-------|--------|
| `users:read` | Чтение пользователей |
| `users:write` | Создание / изменение / удаление пользователей |
| `nodes:read` | Чтение нод |
| `nodes:write` | Создание / изменение / удаление / синхронизация нод |
| `stats:read` | Статистика и группы |
| `sync:write` | Запуск синхронизации, кик пользователей |

#### Rate Limiting

Каждый ключ имеет настраиваемый лимит (по умолчанию: 60 req/мин).  
При превышении возвращается `429` с заголовками `X-RateLimit-Limit` / `X-RateLimit-Remaining`.

#### Коды ошибок

| Код | Причина |
|-----|---------|
| `401` | Ключ недействителен, истёк или не передан |
| `403` | Ключ валиден, но нет нужного скоупа / IP не в списке |
| `429` | Превышен лимит запросов |

---

### Авторизация (для нод)

#### POST `/api/auth`

Проверка пользователя при подключении.

```json
// Запрос
{ "addr": "1.2.3.4:12345", "auth": "userId:password" }

// Ответ (успех)
{ "ok": true, "id": "userId" }

// Ответ (ошибка)
{ "ok": false }
```

### Подписки

#### GET `/api/files/:token`

Универсальный эндпоинт подписки. Автоматически определяет формат по User-Agent.

| User-Agent | Формат |
|------------|--------|
| `shadowrocket` | Base64 URI list |
| `clash`, `stash`, `surge` | Clash YAML |
| `hiddify`, `sing-box` | Sing-box JSON |
| Браузер | HTML страница |
| Другое | Plain URI list |

**Query параметры:** `?format=clash`, `?format=singbox`, `?format=uri`

### Пользователи

Требуемый скоуп: `users:read` (GET) / `users:write` (POST, PUT, DELETE)

| Метод | Эндпоинт | Описание |
|-------|----------|----------|
| GET | `/api/users` | Список пользователей (пагинация, фильтры, сортировка) |
| GET | `/api/users/:userId` | Получить пользователя |
| POST | `/api/users` | Создать пользователя |
| PUT | `/api/users/:userId` | Обновить пользователя |
| DELETE | `/api/users/:userId` | Удалить пользователя |
| POST | `/api/users/:userId/enable` | Включить |
| POST | `/api/users/:userId/disable` | Отключить |
| POST | `/api/users/:userId/groups` | Добавить в группы |
| DELETE | `/api/users/:userId/groups/:groupId` | Удалить из группы |

### Ноды

Требуемый скоуп: `nodes:read` (GET) / `nodes:write` (POST, PUT, DELETE)

| Метод | Эндпоинт | Описание |
|-------|----------|----------|
| GET | `/api/nodes` | Список нод |
| GET | `/api/nodes/:id` | Получить ноду |
| POST | `/api/nodes` | Создать ноду |
| PUT | `/api/nodes/:id` | Обновить ноду |
| DELETE | `/api/nodes/:id` | Удалить ноду |
| GET | `/api/nodes/:id/config` | Получить конфиг (YAML) |
| POST | `/api/nodes/:id/sync` | Синхронизировать ноду |
| POST | `/api/nodes/:id/update-config` | Отправить конфиг через SSH |
| POST | `/api/nodes/:id/setup` | **Авто-настройка** ноды через SSH (долгий запрос, ~1–2 мин) |

### Статистика и синхронизация

Требуемый скоуп: `stats:read` / `sync:write`

| Метод | Эндпоинт | Скоуп | Описание |
|-------|----------|-------|----------|
| GET | `/api/stats` | `stats:read` | Статистика панели |
| GET | `/api/groups` | `stats:read` | Список групп серверов |
| POST | `/api/sync` | `sync:write` | Синхронизировать все ноды |
| POST | `/api/kick/:userId` | `sync:write` | Кикнуть пользователя со всех нод |

---

## 🪝 Вебхуки

Отправляйте уведомления о событиях в реальном времени на любой HTTP-эндпоинт.

**Настройка:** Настройки → Безопасность → Вебхуки

### Формат запроса

```http
POST https://your-endpoint.com/webhook
Content-Type: application/json
X-Webhook-Event: user.created
X-Webhook-Timestamp: 1700000000
X-Webhook-Signature: sha256=<hmac>
User-Agent: C3-Celerity-Webhook/1.0

{
  "event": "user.created",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": { ... }
}
```

### Проверка подписи

```js
const crypto = require('crypto');
const expected = 'sha256=' + crypto
  .createHmac('sha256', YOUR_SECRET)
  .update(`${timestamp}.${rawBody}`)
  .digest('hex');
// сравните с заголовком X-Webhook-Signature
```

### События

| Событие | Когда |
|---------|-------|
| `user.created` | Создан пользователь |
| `user.updated` | Обновлён пользователь |
| `user.deleted` | Удалён пользователь |
| `user.enabled` | Пользователь включён |
| `user.disabled` | Пользователь отключён |
| `user.traffic_exceeded` | Достигнут лимит трафика |
| `user.expired` | Истёк срок подписки |
| `node.online` | Нода перешла в онлайн |
| `node.offline` | Нода ушла в оффлайн |
| `node.error` | Ошибка синхронизации/конфига ноды |
| `sync.completed` | Завершён полный цикл синхронизации |

Оставьте список событий пустым, чтобы получать **все** события.

---

## 🔧 Настройка нод

### Понимание конфигурации ноды

Перед добавлением ноды важно понять ключевые концепции:

#### Порты
- **Основной порт (443)** — порт, на котором слушает Hysteria. Используйте 443 для лучшей совместимости (часто разрешён в файрволах)
- **Диапазон портов (20000-50000)** — дополнительные UDP порты, которые перенаправляются на основной. Помогает обходить QoS/троттлинг
- **Порт статистики (9999)** — внутренний порт для сбора статистики трафика с ноды

#### Домен и SNI — в чём разница?

| Поле | Назначение | Пример |
|------|------------|--------|
| **Domain** | Используется для ACME/Let's Encrypt сертификатов. Должен указывать на IP ноды | `de1.example.com` → `1.2.3.4` |
| **SNI** | Что клиенты показывают при TLS handshake (domain fronting). Может быть любым доменом | `www.google.com` или `bing.com` |

**Типичные сценарии:**
1. **Простая настройка**: Укажите в `Domain` поддомен, указывающий на вашу ноду (напр., `node1.example.com`). `SNI` оставьте пустым.
2. **Domain fronting**: Укажите `Domain` для сертификатов, а `SNI` — популярный домен (напр., `www.bing.com`) для маскировки трафика.
3. **Панель и нода на одном VPS**: Используйте разные поддомены (напр., `panel.example.com` для панели, `node.example.com` для ноды).

> **Примечание:** Домен панели и домен(ы) нод должны быть разными поддоменами, но могут указывать на один IP, если они на одном VPS.

### Автоматическая настройка (рекомендуется)

1. Добавьте ноду в панели (IP, SSH доступ)
2. Нажмите "⚙️ Автонастройка"
3. Панель автоматически:
   - Установит Hysteria 2
   - Настроит ACME сертификаты
   - Настроит port hopping
   - Откроет порты в firewall
   - Запустит сервис

### Ручная настройка

```bash
# Установка Hysteria
bash <(curl -fsSL https://get.hy2.sh/)

# Создайте конфиг /etc/hysteria/config.yaml
listen: :443

acme:
  domains: [node1.example.com]
  email: admin@example.com

auth:
  type: http
  http:
    url: https://panel.example.com/api/auth
    insecure: false

trafficStats:
  listen: :9999
  secret: ваш_секрет

masquerade:
  type: proxy
  proxy:
    url: https://www.google.com
    rewriteHost: true
```

```bash
# Запуск
systemctl enable --now hysteria-server

# Port hopping (перенаправление 20000-50000 на 443)
iptables -t nat -A PREROUTING -p udp --dport 20000:50000 -j REDIRECT --to-port 443
```

### Панель и нода на одном VPS

Можно запустить панель и ноду Hysteria на одном VPS. Панель использует TCP, нода UDP на порту 443 — они не конфликтуют.

**Вариант 1: Использовать домен панели (рекомендуется)**

Укажите для ноды тот же домен что и у панели. При автонастройке сертификаты панели будут автоматически скопированы на ноду.

1. DNS: `panel.example.com` → IP вашего VPS
2. Добавьте ноду с параметрами:
   - IP: IP вашего VPS
   - Domain: `panel.example.com` (тот же что у панели!)
   - Port: 443
3. Нажмите "Автонастройка" — сертификаты скопируются автоматически

**Вариант 2: Без домена (self-signed)**

Оставьте поле домена пустым. Будет сгенерирован самоподписанный сертификат.

1. Добавьте ноду с параметрами:
   - IP: IP вашего VPS
   - Domain: *(оставьте пустым)*
   - Port: 443
2. Нажмите "Автонастройка"

**Почему нельзя использовать другой домен?**

Если указать другой домен (напр., `node.example.com`), ACME/Let's Encrypt не сможет получить сертификат, потому что порт 80 уже занят панелью для обновления её собственного сертификата. Автонастройка предупредит вас об этом.

---

## 📊 Модели данных

### Пользователь

| Поле | Тип | Описание |
|------|-----|----------|
| `userId` | String | Уникальный ID |
| `subscriptionToken` | String | Токен для URL подписки |
| `enabled` | Boolean | Активен ли пользователь |
| `groups` | [ObjectId] | Группы серверов |
| `trafficLimit` | Number | Лимит трафика в байтах (0 = безлимит) |
| `maxDevices` | Number | Лимит устройств (0 = из группы, -1 = безлимит) |
| `expireAt` | Date | Дата истечения |

### Нода

| Поле | Тип | Описание |
|------|-----|----------|
| `name` | String | Название |
| `ip` | String | IP адрес |
| `domain` | String | Домен для SNI/ACME |
| `port` | Number | Основной порт (443) |
| `portRange` | String | Диапазон портов для hopping |
| `groups` | [ObjectId] | Группы серверов |
| `maxOnlineUsers` | Number | Макс. онлайн для балансировки |
| `status` | String | online/offline/error |

### Группа серверов

| Поле | Тип | Описание |
|------|-----|----------|
| `name` | String | Название группы |
| `color` | String | Цвет для UI (#hex) |
| `maxDevices` | Number | Лимит устройств для группы |

---

## 🚫 Фильтрация трафика (ACL)

Управление маршрутизацией трафика на каждой ноде. Доступ: **Панель → Нода → Фильтрация трафика**.

### Встроенные действия

| Действие | Описание |
|----------|----------|
| `reject(...)` | Заблокировать соединение |
| `direct(...)` | Пропустить через сервер |

### Примеры правил

```
reject(suffix:doubleclick.net)     # Блокировка рекламы
reject(suffix:googlesyndication.com)
reject(geoip:cn)                   # Блокировка китайских IP
reject(geoip:private)              # Блокировка приватных IP
direct(all)                        # Разрешить всё остальное
```

### Готовые сценарии

Пресеты в один клик:
- **Блокировать рекламу** — doubleclick, googlesyndication и др.
- **Блокировать CN/Private** — китайские и приватные диапазоны IP
- **RU напрямую** — российские сайты через сервер напрямую
- **Всё напрямую** — без ограничений

### Маршрутизация через свой прокси

Направьте определённый трафик через свой SOCKS5/HTTP прокси:

1. Добавьте прокси в разделе "Прокси-серверы" (напр., `my-proxy`, SOCKS5, `1.2.3.4:1080`)
2. Используйте в правилах: `my-proxy(geoip:ru)` или `my-proxy(suffix:example.com)`

---

## ⚖️ Балансировка нагрузки

Настраивается в разделе "Настройки":

- **Балансировка включена** — сортировка нод по загруженности
- **Скрывать перегруженные** — не выдавать ноды, где онлайн >= максимум

Алгоритм:
1. Получаем ноды пользователя из групп
2. Сортируем по % загрузки (online/max)
3. Фильтруем перегруженные если включено
4. При равной загрузке — по `rankingCoefficient`

---

## 🔒 Лимит устройств

Ограничение одновременных подключений пользователя.

**Приоритет:**
1. Персональный лимит пользователя (`maxDevices > 0`)
2. Минимальный лимит из групп пользователя
3. `-1` = безлимит

При каждом `POST /api/auth`:
1. Запрашиваем `/online` со всех нод
2. Считаем сессии этого userId
3. Отклоняем если `>= maxDevices`

---

## 💾 Бэкапы

- **Автобэкапы** — настраиваются в Настройках
- **Ручной бэкап** — кнопка на дашборде, автоскачивание
- **Восстановление** — загрузите `.tar.gz` архив

---

## 🐳 Docker Compose

```yaml
version: '3.8'

services:
  mongo:
    image: mongo:7
    restart: always
    volumes:
      - mongo_data:/data/db
    environment:
      MONGO_INITDB_ROOT_USERNAME: ${MONGO_USER:-hysteria}
      MONGO_INITDB_ROOT_PASSWORD: ${MONGO_PASSWORD}

  backend:
    image: clickdevtech/hysteria-panel:latest  # или build: . для разработки
    restart: always
    depends_on:
      - mongo
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./logs:/app/logs
      - ./greenlock.d:/app/greenlock.d
      - ./backups:/app/backups
    env_file:
      - .env

volumes:
  mongo_data:
```

---

## 📝 Переменные окружения

| Переменная | Обязательно | Описание |
|------------|-------------|----------|
| `PANEL_DOMAIN` | ✅ | Домен панели |
| `ACME_EMAIL` | ✅ | Email для Let's Encrypt |
| `ENCRYPTION_KEY` | ✅ | Ключ шифрования SSH (32 символа) |
| `SESSION_SECRET` | ✅ | Секрет сессий |
| `MONGO_PASSWORD` | ✅ | Пароль MongoDB |
| `MONGO_USER` | ❌ | Пользователь MongoDB (default: hysteria) |
| `PANEL_IP_WHITELIST` | ❌ | IP whitelist для панели |
| `SYNC_INTERVAL` | ❌ | Интервал синхронизации в минутах (default: 2) |
| `API_DOCS_ENABLED` | ❌ | Включить интерактивную документацию API на `/api/docs` (default: false) |

---

## 🤝 Участие в разработке

Pull requests приветствуются!

---

## 📄 Лицензия

MIT



