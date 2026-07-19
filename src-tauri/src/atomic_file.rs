use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

use uuid::Uuid;

pub fn replace_existing_file_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    let target = fs::canonicalize(path)?;
    let metadata = fs::metadata(&target)?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "atomic replacement target is not a file: {}",
                path.display()
            ),
        ));
    }

    replace_target_atomic(&target, data, Some(metadata.permissions()))
}

pub fn write_file_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    match fs::canonicalize(path) {
        Ok(target) => {
            let metadata = fs::metadata(&target)?;
            if !metadata.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("atomic write target is not a file: {}", path.display()),
                ));
            }
            replace_target_atomic(&target, data, Some(metadata.permissions()))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let file_name = path.file_name().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("atomic write target has no file name: {}", path.display()),
                )
            })?;
            let parent = path
                .parent()
                .filter(|value| !value.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            let canonical_parent = fs::canonicalize(parent)?;
            replace_target_atomic(&canonical_parent.join(file_name), data, None)
        }
        Err(error) => Err(error),
    }
}

fn replace_target_atomic(
    target: &Path,
    data: &[u8],
    permissions: Option<fs::Permissions>,
) -> io::Result<()> {
    let parent = target.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "atomic replacement target has no parent: {}",
                target.display()
            ),
        )
    })?;
    let temp_path = parent.join(format!(".memory-forge-{}.tmp", Uuid::new_v4()));

    let result = (|| {
        let mut temp = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)?;
        temp.write_all(data)?;
        temp.flush()?;
        temp.sync_all()?;
        if let Some(permissions) = permissions {
            fs::set_permissions(&temp_path, permissions)?;
        }
        drop(temp);
        fs::rename(&temp_path, target)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("memory-forge-atomic-file-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_files(path: &Path) -> Vec<PathBuf> {
        fs::read_dir(path)
            .expect("read test directory")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with(".memory-forge-") && name.ends_with(".tmp")
                    })
            })
            .collect()
    }

    #[test]
    fn atomically_replaces_existing_file() {
        let dir = TestDir::new();
        let target = dir.path().join("session.jsonl");
        fs::write(&target, "before\n").expect("write original file");

        replace_existing_file_atomic(&target, b"after\n").expect("replace file");

        assert_eq!(
            fs::read_to_string(&target).expect("read replaced file"),
            "after\n"
        );
        assert!(temp_files(dir.path()).is_empty());
    }

    #[test]
    fn rejects_directory_targets_without_temp_files() {
        let dir = TestDir::new();
        let target = dir.path().join("session.jsonl");
        fs::create_dir_all(&target).expect("create directory target");

        let error = replace_existing_file_atomic(&target, b"after\n")
            .expect_err("directory replacement must fail");

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(target.is_dir());
        assert!(temp_files(dir.path()).is_empty());
    }

    #[test]
    fn atomically_creates_new_file() {
        let dir = TestDir::new();
        let target = dir.path().join("export.md");

        write_file_atomic(&target, b"# Export\n").expect("create file");

        assert_eq!(
            fs::read_to_string(&target).expect("read created file"),
            "# Export\n"
        );
        assert!(temp_files(dir.path()).is_empty());
    }

    #[test]
    fn atomic_write_rejects_directory_targets() {
        let dir = TestDir::new();
        let target = dir.path().join("export.md");
        fs::create_dir_all(&target).expect("create directory target");

        let error =
            write_file_atomic(&target, b"# Export\n").expect_err("directory write must fail");

        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(target.is_dir());
        assert!(temp_files(dir.path()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn preserves_unix_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TestDir::new();
        let target = dir.path().join("session.jsonl");
        fs::write(&target, "before\n").expect("write original file");
        fs::set_permissions(&target, fs::Permissions::from_mode(0o640))
            .expect("set original permissions");

        replace_existing_file_atomic(&target, b"after\n").expect("replace file");

        let mode = fs::metadata(&target)
            .expect("read metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o640);
    }
}
