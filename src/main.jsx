import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { BCIProvider } from "./bci/BCIProvider.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BCIProvider>
      <App />
    </BCIProvider>
  </React.StrictMode>
);
