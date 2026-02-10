# Lead Processor (LPTracker Webhook → Telegram)

## Что делает
- Принимает webhook от LPTracker при изменении лида
- Определяет адрес по ключевым словам
- Отправляет payload целиком в нужный Telegram-чат

## Запуск локально
1. Установить зависимости
   - `npm install`
2. Создать `.env` по шаблону `.env.example`
3. Запустить
   - `npm start`

## Деплой в Render
1. Создать новый Web Service
2. Подключить GitHub репозиторий с этой папкой
3. Build Command: `npm install`
4. Start Command: `npm start`
5. В разделе Environment добавить переменные из `.env.example`

## Настройка webhook в LPTracker
LPTracker принимает URL обратного вызова через API `lead/callback`. Нужно передать `project_id` и `url`. Пример:
