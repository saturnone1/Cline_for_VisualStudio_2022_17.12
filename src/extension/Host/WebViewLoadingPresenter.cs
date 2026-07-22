using System;
using System.IO;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;

namespace VsClineAgent.Host
{
    internal sealed class WebViewLoadingPresenter
    {
		internal TimeSpan BlankDiagnosticDelay { get; } = ResolveBlankDiagnosticDelay();
        private readonly Control _owner;
        private readonly Image _logo;
        private readonly TextBlock _title;
        private readonly TextBlock _brand;
        private readonly TextBlock _status;
        private readonly ProgressBar _progress;
        private readonly TextBox _error;
        private readonly Storyboard? _loadingAnimation;
        private bool _animationRunning;

        internal WebViewLoadingPresenter(Control owner, Image logo, TextBlock title, TextBlock brand, TextBlock status, ProgressBar progress, TextBox error)
        {
            _owner = owner;
            _logo = logo;
            _title = title;
            _brand = brand;
            _status = status;
            _progress = progress;
            _error = error;
            _loadingAnimation = owner.FindResource("LoadingAnimationStoryboard") as Storyboard;
        }

        internal void InitializeLogo(string assemblyDirectory)
        {
            try
            {
                var logoPath = Path.Combine(assemblyDirectory, "Assets", "lig-mark-white.png");
                if (!File.Exists(logoPath)) return;
                var bitmap = new BitmapImage();
                bitmap.BeginInit();
                bitmap.CacheOption = BitmapCacheOption.OnLoad;
                bitmap.UriSource = new Uri(logoPath, UriKind.Absolute);
                bitmap.EndInit();
                bitmap.Freeze();
                _logo.Source = bitmap;
            }
            catch
            {
                // The loading view remains usable when an optional logo cannot be decoded.
            }
        }

        internal void StartAnimation()
        {
            if (_animationRunning || _loadingAnimation == null) return;
            _loadingAnimation.Begin(_owner, HandoffBehavior.SnapshotAndReplace, true);
            _animationRunning = true;
        }

        internal void StopAnimation()
        {
            if (!_animationRunning || _loadingAnimation == null) return;
            _loadingAnimation.Remove(_owner);
            _animationRunning = false;
        }

        internal void ApplyTheme(string theme)
        {
            void Apply()
            {
                var isLight = string.Equals(theme, UiThemePreferenceStore.LightTheme, StringComparison.OrdinalIgnoreCase);
                _owner.Background = Brush(isLight ? "#F7F8FA" : "#1E1E1E");
                _title.Foreground = Brush(isLight ? "#172033" : "#CCCCCC");
                _brand.Foreground = Brush(isLight ? "#4B5563" : "#888888");
                _status.Foreground = Brush(isLight ? "#4B5563" : "#888888");
                _progress.Foreground = Brush(isLight ? "#0969B7" : "#0E70C0");
                _progress.Background = Brush(isLight ? "#D9DEE7" : "#333333");
                _error.Foreground = Brush(isLight ? "#B42318" : "#F44747");
                _error.Background = Brush(isLight ? "#FFFFFF" : "#1E1E1E");
                _error.BorderBrush = Brush(isLight ? "#C7CCD4" : "#3C3C3C");
                ApplyGlowTheme(isLight);
            }

            if (_owner.Dispatcher.CheckAccess()) Apply();
            else VisualStudioUiThread.Post(Apply);
        }

        internal void SetStatus(string message)
        {
            if (_owner.Dispatcher.CheckAccess()) _status.Text = message;
            else VisualStudioUiThread.Post(() => _status.Text = message);
        }

        private static SolidColorBrush Brush(string color)
        {
            var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(color));
            brush.Freeze();
            return brush;
        }

        private void ApplyGlowTheme(bool isLight)
        {
            var glowColor = ParseColor(isLight ? "#0969B7" : "#2B9AD6");
            if (_owner.FindName("loadingOrbitRing") is System.Windows.Shapes.Ellipse orbit)
                orbit.Stroke = Brush(isLight ? "#0969B7" : "#2B9AD6");
            if (_owner.FindName("loadingLogoHalo") is System.Windows.Shapes.Ellipse halo)
                halo.Fill = Brush(isLight ? "#0969B7" : "#2B9AD6");
            foreach (var name in new[] { "loadingOrbitGlowEffect", "loadingLogoGlowEffect", "loadingTitleGlowEffect", "loadingBrandGlowEffect" })
                if (_owner.FindName(name) is DropShadowEffect effect) effect.Color = glowColor;
        }

        private static Color ParseColor(string color)
        {
            return (Color)ColorConverter.ConvertFromString(color);
        }

		private static TimeSpan ResolveBlankDiagnosticDelay()
		{
			const int defaultMilliseconds = 15000;
			var configured = Environment.GetEnvironmentVariable("VSCLINE_WEBVIEW_DIAGNOSTIC_DELAY_MS");
			return int.TryParse(configured, out var milliseconds) && milliseconds >= 1000 && milliseconds <= 120000
				? TimeSpan.FromMilliseconds(milliseconds)
				: TimeSpan.FromMilliseconds(defaultMilliseconds);
		}
    }
}
