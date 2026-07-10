# Project standard

## Icons
- **Всегда использовать иконки из библиотеки lucide (lucide-react icon set).** Никогда не рисовать SVG-иконки вручную и не копировать пути.
- В DC-шаблонах иконки подключаются через обёртку `LucideIcon` (файл `lucide-icon.js`), которая рендерит настоящие lucide-иконки через host React:
  ```html
  <x-import component-from-global-scope="LucideIcon" from="./lucide-icon.js"
            name="chevron-right" size="16" hint-size="16px,16px"
            style="display:inline-flex;flex:none"></x-import>
  ```
- `name` — kebab-case имя иконки, как в lucide-react (например `message-square`, `arrow-up-right`, `chevron-left`).
- Пропсы: `size` (px), `color` (по умолчанию `currentColor` — наследует цвет текста), `strokeWidth` (по умолчанию 2).
