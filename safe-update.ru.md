# Безопасное обновление на проде

Пошаговое руководство по обновлению C³ CELERITY на production-сервере с минимальным временем простоя.

---

## 📋 Предварительный чеклист

Перед любым обновлением:

1. **Создайте резервную копию базы данных**
   ```bash
   # Через UI панели: Дашборд → Бэкап → Скачать
   # Или вручную через mongodump:
   docker exec hysteria-mongo mongodump --archive=/data/db/backup.archive --username=hysteria --password --authenticationDatabase=admin
   docker cp hysteria-mongo:/data/db/backup.archive ./backup-$(date +%Y%m%d-%H%M%S).archive
   ```

2. **Проверьте текущую версию**
   ```bash
   docker logs hysteria-backend --tail 50 | grep -i version
   ```

3. **Проверьте свободное место на диске**
   ```bash
   df -h
   # Минимум 2GB свободного места для нового образа
   ```

4. **Сохраните текущий .env файл**
   ```bash
   cp .env .env.backup-$(date +%Y%m%d)
   ```

---

## 🚀 Обновление (Docker Hub — рекомендуется)

Для production-развертывания через `docker-compose.hub.yml`:

### 1. Перейдите в директорию проекта

```bash
cd /path/to/hysteria-panel
```

### 2. Остановите текущие контейнеры (короткое время простоя)

```bash
docker compose -f docker-compose.hub.yml down
```

> **Время простоя:** ~10-30 секунд

### 3. Скачайте новый образ

```bash
docker compose -f docker-compose.hub.yml pull
```

### 4. Запустите обновлённые контейнеры

```bash
docker compose -f docker-compose.hub.yml up -d
```

### 5. Проверьте статус

```bash
# Все контейнеры должны быть "running"
docker compose -f docker-compose.hub.yml ps

# Проверьте логи на ошибки
docker logs hysteria-backend --tail 100 -f
```

### 6. Проверьте доступность

```bash
curl -I https://ваш-домен/panel
```

---

## 🔧 Обновление (сборка из исходников)

Для развертывания через `docker-compose.yml` с локальной сборкой:

### 1. Перейдите в директорию проекта

```bash
cd /path/to/hysteria-panel
```

### 2. Получите последние изменения

```bash
git fetch origin
git status  # проверьте незакоммиченные изменения
git pull origin main
```

### 3. Остановите текущие контейнеры

```bash
docker compose down
```

### 4. Пересоберите образ

```bash
docker compose build --no-cache backend
```

> **Время:** 2-5 минут в зависимости от сервера

### 5. Запустите контейнеры

```bash
docker compose up -d
```

### 6. Проверьте статус

```bash
docker compose ps
docker logs hysteria-backend --tail 100 -f
```

---

## 🔄 Откат на предыдущую версию

Если после обновления возникли проблемы:

### Вариант 1: Откат на конкретную версию образа

1. Отредактируйте `docker-compose.hub.yml`:
   ```yaml
   backend:
     image: clickdevtech/hysteria-panel:v1.2.3  # укажите нужную версию
   ```

2. Примените изменения:
   ```bash
   docker compose -f docker-compose.hub.yml down
   docker compose -f docker-compose.hub.yml pull
   docker compose -f docker-compose.hub.yml up -d
   ```

### Вариант 2: Откат на предыдущий git-коммит

```bash
# Найдите предыдущий рабочий коммит
git log --oneline -10

# Откатитесь
git checkout <commit-hash>

# Пересоберите
docker compose build --no-cache backend
docker compose up -d
```

### Вариант 3: Восстановление базы данных

```bash
# Восстановление из бэкапа
docker cp ./backup.archive hysteria-mongo:/data/db/backup.archive
docker exec hysteria-mongo mongorestore --archive=/data/db/backup.archive --drop --username=hysteria --password --authenticationDatabase=admin
```

---

## ✅ После обновления

1. **Проверьте авторизацию** — войдите в панель
2. **Проверьте ноды** — статус всех нод должен быть `online`
3. **Проверьте подписки** — откройте ссылку подписки в браузере
4. **Проверьте API** — выполните тестовый запрос с API-ключом
5. **Мониторьте логи** в течение 10-15 минут:
   ```bash
   docker logs hysteria-backend -f --tail 50
   ```

---

## ⚠️ Типичные проблемы

### Контейнер не стартует

```bash
# Проверьте логи
docker logs hysteria-backend

# Частые причины:
# - Ошибка в .env файле
# - Проблема с подключением к MongoDB
# - Нехватка памяти
```

### MongoDB не подключается

```bash
# Проверьте статус MongoDB
docker logs hysteria-mongo --tail 50

# Перезапустите MongoDB
docker compose restart mongo
```

### SSL-сертификаты не работают

```bash
# Проверьте содержимое greenlock.d
ls -la greenlock.d/

# Перезапустите с очисткой кэша
docker compose down
docker compose up -d
```

---

## 📅 Рекомендуемое расписание

| Действие | Частота |
|----------|---------|
| Бэкап базы | Ежедневно (авто) + перед обновлением |
| Проверка обновлений | Еженедельно |
| Обновление security-патчей | В течение 48 часов |
| Мажорные обновления | После тестирования на staging |

---

## 🛡️ Рекомендации

1. **Тестируйте на staging** — дублирующая среда для проверки обновлений
2. **Обновляйте в низконагруженное время** — ночь/раннее утро по времени пользователей
3. **Держите бэкапы** — минимум 3 последних бэкапа базы
4. **Документируйте изменения** — сохраняйте записи о версиях и датах обновлений
5. **Не обновляйте всё сразу** — сначала панель, затем при необходимости ноды

---

## 📞 Если что-то пошло не так

1. Не паникуйте — данные в MongoDB сохранены
2. Проверьте логи: `docker logs hysteria-backend --tail 200`
3. Откатитесь на предыдущую версию
4. При необходимости восстановите базу из бэкапа
5. Создайте issue на GitHub с описанием проблемы и логами
