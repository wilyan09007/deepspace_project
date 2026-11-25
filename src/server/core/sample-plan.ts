/**
 * Captured output of one real planner run on the live app (phase 10,
 * 2026-11-25, billed to the app owner: 13 credits). Exported with the
 * `exportPlan` action; only `description` was written by hand, to say where
 * the plan came from. Never hand-write tasks here.
 */
import type { SamplePlan } from './sample'

export const SAMPLE_PLAN: SamplePlan | null = {
  "repo": "gothinkster/react-redux-realworld-example-app",
  "branch": "master",
  "description": "Plan captured from one real planner run (claude-sonnet-5-5, 2026-11-25) on the RealWorld React + Redux example app.",
  "goalTitle": "Add a dark mode toggle to the Settings page",
  "goalBody": "Users can switch between light and dark themes from Settings. The choice persists across reloads and applies to every page.",
  "summary": "Add a theme slice to the Redux store, with the choice saved to localStorage under the key `theme` ('light' or 'dark'). Dark styles are keyed on a `data-theme` attribute on the root element, and the toggle lives in Settings.",
  "model": "claude-sonnet-5-5",
  "capturedAt": "2026-11-25",
  "tasks": [
    {
      "title": "Add theme action type and reducer",
      "body": "Add a `THEME_SET` action type to src/constants/actionTypes.js. Create src/reducers/theme.js. Its state is `{ mode: 'light' | 'dark' }`. The initial mode is read from `window.localStorage.getItem('theme')`, and anything other than 'dark' falls back to 'light'. On `THEME_SET` it sets `mode` to `action.mode`. Register the reducer as `theme` in src/reducer.js.",
      "acceptance": "The store state has `theme.mode`. Dispatching `{type: THEME_SET, mode: 'dark'}` changes it to 'dark'. With localStorage `theme` set to 'dark' before load, the initial state is 'dark'. The app still builds.",
      "predictedFiles": [
        "src/constants/actionTypes.js",
        "src/reducers/theme.js",
        "src/reducer.js"
      ],
      "dependsOn": []
    },
    {
      "title": "Persist theme choice in middleware",
      "body": "In src/middleware.js, extend the existing localStorage middleware, or add a small one alongside it. On `THEME_SET`, write `action.mode` to `localStorage` under the key `theme`. Do not change how the jwt is handled. src/store.js should need no change if the middleware is already applied there. If a new middleware is added, wire it in src/store.js.",
      "acceptance": "After dispatching THEME_SET with 'dark', `localStorage.getItem('theme')` returns 'dark'. Existing login and logout token persistence still works.",
      "predictedFiles": [
        "src/middleware.js"
      ],
      "dependsOn": [
        0
      ]
    },
    {
      "title": "Create dark theme stylesheet",
      "body": "Create src/dark-theme.css with overrides scoped under `[data-theme=\"dark\"]`. Cover the body background and text, navbar, banner, article previews, cards, form inputs, comments, tags, pagination and links, so every page is readable in dark mode. Import it from src/index.js. Do not touch components.",
      "acceptance": "Manually adding `data-theme=\"dark\"` to the html element in the browser gives a dark, readable UI on the home, article, editor, profile, login and settings pages. Removing the attribute restores the original look.",
      "predictedFiles": [
        "src/dark-theme.css",
        "src/index.js"
      ],
      "dependsOn": []
    },
    {
      "title": "Apply theme attribute app-wide and avoid flash on load",
      "body": "In src/components/App.js, map `state.theme.mode` to props. Whenever it changes, including on mount, set `document.documentElement.setAttribute('data-theme', mode)`. In public/index.html, add a tiny inline script in the head that reads `localStorage.getItem('theme')` and sets `data-theme` on the html element before first paint. Wrap localStorage access in try/catch.",
      "acceptance": "Changing `theme.mode` in the store updates the `data-theme` attribute on the html element on any route. After a reload with 'dark' saved, the attribute is present from the first paint.",
      "predictedFiles": [
        "src/components/App.js",
        "public/index.html"
      ],
      "dependsOn": [
        0
      ]
    },
    {
      "title": "Add dark mode toggle to Settings page",
      "body": "In src/components/Settings.js, add a 'Dark mode' checkbox or toggle, separate from the profile form. It reflects `state.theme.mode` and dispatches `{type: THEME_SET, mode: 'dark' | 'light'}` on change. Add the props through the existing mapStateToProps and mapDispatchToProps. Toggling must not submit the settings form or trigger a save request.",
      "acceptance": "On /settings the toggle shows the current theme. Clicking it switches the theme immediately, and the choice survives a reload and applies on other pages. No settings update request is sent.",
      "predictedFiles": [
        "src/components/Settings.js"
      ],
      "dependsOn": [
        0
      ]
    }
  ],
  "importEdges": {
    "src/components/App.js": [
      "src/agent.js",
      "src/components/Article/index.js",
      "src/components/Editor.js",
      "src/components/Header.js",
      "src/components/Home/index.js",
      "src/components/Login.js",
      "src/components/Profile.js",
      "src/components/ProfileFavorites.js",
      "src/components/Register.js",
      "src/components/Settings.js",
      "src/constants/actionTypes.js",
      "src/store.js"
    ],
    "src/components/Settings.js": [
      "src/agent.js",
      "src/components/ListErrors.js",
      "src/constants/actionTypes.js"
    ],
    "src/index.js": [
      "src/components/App.js",
      "src/store.js"
    ],
    "src/middleware.js": [
      "src/agent.js",
      "src/constants/actionTypes.js"
    ],
    "src/reducer.js": [
      "src/reducers/article.js",
      "src/reducers/articleList.js",
      "src/reducers/auth.js",
      "src/reducers/common.js",
      "src/reducers/editor.js",
      "src/reducers/home.js",
      "src/reducers/profile.js",
      "src/reducers/settings.js"
    ]
  }
}
