// Budget Dispatcher -- system tray app.
// Compiled: scripts\build-tray.cmd -> bin\BudgetDispatcher.exe
// Port of scripts\tray.ps1 to C# for proper app identity in Windows tray settings.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("Budget Dispatcher")]
[assembly: AssemblyProduct("BudgetDispatcher")]
[assembly: AssemblyVersion("1.0.0.0")]

namespace BudgetDispatcher
{
    static class Program
    {
        const string API_BASE = "http://localhost:7380";
        const int POLL_INTERVAL_MS = 30000;
        const string MUTEX_NAME = "Global\\claude-budget-dispatcher-tray";

        static Mutex mutex;
        static NotifyIcon tray;
        static Icon iconGreen, iconYellow, iconRed;
        static WebClient wc;
        static System.Windows.Forms.Timer timer;
        static ContextMenuStrip menu;
        static Font boldFont;
        static ToolStripMenuItem miAuto, miNode, miClaude, miPause;
        static bool lastPaused;

        static string repoRoot;
        static string assetsDir;
        static string launcherPath;

        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // Single-instance guard
            bool owned = false;
            mutex = new Mutex(false, MUTEX_NAME);
            try { owned = mutex.WaitOne(0, false); } catch { }
            if (!owned)
            {
                mutex.Dispose();
                return;
            }

            // Resolve paths: exe is in bin/, repo root is one level up
            string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            repoRoot = Path.GetFullPath(Path.Combine(exeDir, ".."));
            assetsDir = Path.Combine(repoRoot, "assets");
            launcherPath = Path.Combine(repoRoot, "scripts", "dashboard-launcher.cmd");

            // Load icons
            iconGreen = LoadIcon("green");
            iconYellow = LoadIcon("yellow");
            iconRed = LoadIcon("red");

            // HTTP client
            wc = new WebClient();
            wc.Encoding = System.Text.Encoding.UTF8;

            // Build context menu
            menu = new ContextMenuStrip();

            ToolStripMenuItem miOpen = (ToolStripMenuItem)menu.Items.Add("Open Dashboard");
            boldFont = new Font(miOpen.Font, FontStyle.Bold);
            miOpen.Font = boldFont;
            miOpen.Click += delegate { OpenDashboard(); };

            menu.Items.Add(new ToolStripSeparator());

            miAuto = (ToolStripMenuItem)menu.Items.Add("Engine: Auto");
            miNode = (ToolStripMenuItem)menu.Items.Add("Engine: Free Only");
            miClaude = (ToolStripMenuItem)menu.Items.Add("Engine: Claude");

            miAuto.Click += delegate { ApiPost("/api/engine", "{\"engine\":\"auto\"}"); UpdateStatus(); };
            miNode.Click += delegate { ApiPost("/api/engine", "{\"engine\":\"node\"}"); UpdateStatus(); };
            miClaude.Click += delegate { ApiPost("/api/engine", "{\"engine\":\"claude\"}"); UpdateStatus(); };

            menu.Items.Add(new ToolStripSeparator());

            miPause = (ToolStripMenuItem)menu.Items.Add("Pause");
            miPause.Click += delegate
            {
                string target = lastPaused ? "false" : "true";
                ApiPost("/api/pause", "{\"paused\":" + target + "}");
                UpdateStatus();
            };

            ToolStripMenuItem miDispatch = (ToolStripMenuItem)menu.Items.Add("Dispatch Now");
            miDispatch.Click += delegate { ApiPost("/api/dispatch", "{\"dry_run\":false}"); };

            menu.Items.Add(new ToolStripSeparator());

            ToolStripMenuItem miQuit = (ToolStripMenuItem)menu.Items.Add("Quit");
            miQuit.Click += delegate { Application.Exit(); };

            // Create NotifyIcon
            tray = new NotifyIcon();
            tray.Icon = iconGreen;
            tray.Text = "Budget Dispatcher";
            tray.ContextMenuStrip = menu;
            tray.Visible = true;

            tray.DoubleClick += delegate { OpenDashboard(); };

            // Polling timer
            timer = new System.Windows.Forms.Timer();
            timer.Interval = POLL_INTERVAL_MS;
            timer.Tick += delegate { UpdateStatus(); };

            // Initial poll, then start timer
            UpdateStatus();
            timer.Start();

            // Run message loop (blocks until Application.Exit)
            Application.Run();

            Cleanup();
        }

        static Icon LoadIcon(string name)
        {
            string path = Path.Combine(assetsDir, "tray-" + name + ".ico");
            if (File.Exists(path))
            {
                return new Icon(path);
            }
            return SystemIcons.Application;
        }

        static Dictionary<string, object> ApiGet(string path)
        {
            try
            {
                string json = wc.DownloadString(API_BASE + path);
                var serializer = new JavaScriptSerializer();
                return serializer.Deserialize<Dictionary<string, object>>(json);
            }
            catch
            {
                return null;
            }
        }

        static void ApiPost(string path, string body)
        {
            try
            {
                wc.Headers["Content-Type"] = "application/json";
                wc.UploadString(API_BASE + path, "POST", body);
            }
            catch { }
        }

        static void UpdateStatus()
        {
            Dictionary<string, object> state = ApiGet("/api/state");

            if (state == null)
            {
                tray.Icon = iconRed;
                tray.Text = "Budget Dispatcher: Dashboard offline";
                miPause.Text = "Pause";
                miAuto.Checked = false;
                miNode.Checked = false;
                miClaude.Checked = false;
                return;
            }

            // Determine health level
            bool isPaused = GetBool(state, "paused") || GetBool(state, "pause_file_exists");
            lastPaused = isPaused;

            int recentErrors = 0;
            ArrayList logs = GetField(state, "recent_logs") as ArrayList;
            if (logs != null)
            {
                foreach (object log in logs)
                {
                    if (recentErrors >= 3) break;
                    Dictionary<string, object> entry = log as Dictionary<string, object>;
                    if (entry != null && "error".Equals(GetString(entry, "outcome")))
                    {
                        recentErrors++;
                    }
                }
            }

            string tip;
            if (recentErrors >= 2)
            {
                tray.Icon = iconRed;
                tip = "Errors detected (" + recentErrors + " in recent runs)";
            }
            else if (isPaused)
            {
                tray.Icon = iconYellow;
                tip = "Paused";
            }
            else
            {
                Dictionary<string, object> budget = GetField(state, "budget") as Dictionary<string, object>;
                if (budget != null && GetBool(budget, "dispatch_authorized"))
                {
                    tray.Icon = iconGreen;
                    tip = "Healthy (Claude authorized)";
                }
                else
                {
                    tray.Icon = iconGreen;
                    tip = "Healthy (free models)";
                }
            }

            // Engine info
            string eng = GetString(state, "engine_override");
            if (eng == null) eng = "auto";
            tip += " | Engine: " + eng;

            // Today's runs
            object todayRuns = GetField(state, "today_runs");
            if (todayRuns != null)
            {
                tip += " | Runs: " + todayRuns.ToString();
            }

            // Tooltip max 63 chars (Windows limit)
            if (tip.Length > 63) tip = tip.Substring(0, 60) + "...";
            tray.Text = tip;

            // Update menu checkmarks
            miAuto.Checked = (eng == "auto");
            miNode.Checked = (eng == "node");
            miClaude.Checked = (eng == "claude");

            // Pause button text
            miPause.Text = isPaused ? "Resume" : "Pause";
        }

        static void OpenDashboard()
        {
            try
            {
                Process.Start(launcherPath);
            }
            catch { }
        }

        static void Cleanup()
        {
            timer.Stop();
            timer.Dispose();
            tray.Visible = false;
            tray.Dispose();
            wc.Dispose();
            if (menu != null) menu.Dispose();
            if (boldFont != null) boldFont.Dispose();
            if (iconGreen != null && iconGreen != SystemIcons.Application) iconGreen.Dispose();
            if (iconYellow != null && iconYellow != SystemIcons.Application) iconYellow.Dispose();
            if (iconRed != null && iconRed != SystemIcons.Application) iconRed.Dispose();
            try { mutex.ReleaseMutex(); } catch { }
            mutex.Dispose();
        }

        // ---- Safe dictionary access helpers ----

        static object GetField(Dictionary<string, object> dict, string key)
        {
            object val;
            if (dict != null && dict.TryGetValue(key, out val)) return val;
            return null;
        }

        static bool GetBool(Dictionary<string, object> dict, string key)
        {
            object val = GetField(dict, key);
            if (val is bool) return (bool)val;
            return false;
        }

        static string GetString(Dictionary<string, object> dict, string key)
        {
            object val = GetField(dict, key);
            return val != null ? val.ToString() : null;
        }
    }
}
