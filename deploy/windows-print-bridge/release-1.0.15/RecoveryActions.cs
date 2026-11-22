// Windows service recovery lists contain native pointers. Read and write through
// SCM so changes take effect immediately, preserving unrelated settings and strings.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

public class MboxRecoveryActions
{
    public uint ResetSeconds;
    public uint[] Actions;
    public bool OnError;

    [StructLayout(LayoutKind.Sequential)]
    private struct FailureActions
    {
        public uint ResetPeriod;
        public IntPtr RebootMessage;
        public IntPtr Command;
        public int Count;
        public IntPtr Steps;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool QueryServiceConfig2W(SafeHandle service, int level, IntPtr buffer, int size, out int needed);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool ChangeServiceConfig2W(SafeHandle service, int level, ref FailureActions actions);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool ChangeServiceConfig2W(SafeHandle service, int level, ref int flag);

    private static void Check(bool success)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    private static IntPtr Query(SafeHandle service, int level)
    {
        int size;
        QueryServiceConfig2W(service, level, IntPtr.Zero, 0, out size);
        if (Marshal.GetLastWin32Error() != 122 || size <= 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Check(QueryServiceConfig2W(service, level, buffer, size, out size));
            return buffer;
        }
        catch { Marshal.FreeHGlobal(buffer); throw; }
    }

    public static MboxRecoveryActions Read(SafeHandle service)
    {
        var result = new MboxRecoveryActions();
        IntPtr buffer = Query(service, 2);
        try
        {
            var policy = (FailureActions)Marshal.PtrToStructure(buffer, typeof(FailureActions));
            result.ResetSeconds = policy.ResetPeriod;
            result.Actions = new uint[checked(policy.Count * 2)];
            for (int i = 0; i < result.Actions.Length; i++)
                result.Actions[i] = unchecked((uint)Marshal.ReadInt32(policy.Steps, i * 4));
        }
        finally { Marshal.FreeHGlobal(buffer); }

        buffer = Query(service, 4);
        try { result.OnError = Marshal.ReadInt32(buffer) != 0; }
        finally { Marshal.FreeHGlobal(buffer); }
        return result;
    }

    public static void Write(SafeHandle service, uint resetSeconds, uint[] actions, bool onError)
    {
        if (actions == null || actions.Length % 2 != 0) throw new ArgumentException("Incomplete SC_ACTION");
        // For zero actions Windows requires a non-null pointer to delete the previous list.
        IntPtr steps = Marshal.AllocHGlobal(Math.Max(1, checked(actions.Length * 4)));
        try
        {
            for (int i = 0; i < actions.Length; i++)
            {
                if (i % 2 == 0 && actions[i] == 2) EnableShutdownPrivilege();
                Marshal.WriteInt32(steps, i * 4, unchecked((int)actions[i]));
            }
            var policy = new FailureActions { ResetPeriod = resetSeconds, Steps = steps, Count = actions.Length / 2 };
            Check(ChangeServiceConfig2W(service, 2, ref policy));
            int flag = onError ? 1 : 0;
            Check(ChangeServiceConfig2W(service, 4, ref flag));
        }
        finally { Marshal.FreeHGlobal(steps); }
    }

    // Restoring a pre-existing SC_ACTION_REBOOT policy requires this privilege.
    [StructLayout(LayoutKind.Sequential)]
    private struct TokenPrivilege { public int Count; public uint Low; public int High; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Luid { public uint Low; public int High; }
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, int access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool LookupPrivilegeValue(string system, string name, out Luid luid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivilege state, int size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static void EnableShutdownPrivilege()
    {
        Luid luid;
        Check(LookupPrivilegeValue(null, "SeShutdownPrivilege", out luid));
        IntPtr token;
        using (var process = Process.GetCurrentProcess())
            Check(OpenProcessToken(process.Handle, 0x28, out token));
        try
        {
            var state = new TokenPrivilege { Count = 1, Low = luid.Low, High = luid.High, Attributes = 2 };
            Check(AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero));
            int error = Marshal.GetLastWin32Error();
            if (error != 0) throw new Win32Exception(error);
        }
        finally { CloseHandle(token); }
    }
}
