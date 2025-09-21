import React from "react";
import ReactDOM from "react-dom/client";
import Whiteboard from "./whiteboard.jsx";  // ⬅ fixed import name
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Whiteboard />
  </React.StrictMode>
);
