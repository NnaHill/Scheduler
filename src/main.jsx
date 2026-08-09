import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import AuthGate from "./AuthGate.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthGate>
      {({ session, profile, signOut }) => <App session={session} profile={profile} onSignOut={signOut} />}
    </AuthGate>
  </React.StrictMode>
);
