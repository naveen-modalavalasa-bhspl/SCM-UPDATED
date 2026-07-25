// @ts-nocheck
import React, { useState } from 'react';
import {
  Modal, Button, Upload, Table, Tag, Space, Alert, Progress, Tooltip, App,
} from 'antd';
import {
  InboxOutlined, DownloadOutlined, CloudUploadOutlined,
  CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import api from '../config/api';
import { getErrorMessage } from '../utils/helpers';

const { Dragger } = Upload;

const splitCsvIntoRows = (text) => {
  const lines = [];
  let row = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];
    if (char === '"') {
      inQuotes = !inQuotes;
      row += char;
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (row.trim()) {
        lines.push(row);
      }
      row = '';
      if (char === '\r' && nextChar === '\n') {
        i++; // skip \n of \r\n
      }
    } else {
      row += char;
    }
  }
  if (row.trim()) {
    lines.push(row);
  }
  return lines;
};

const BulkUploadModal = ({ open, onClose, onUploadSuccess }) => {
  const { message } = App.useApp();
  const [fileList, setFileList] = useState([]);
  const [validating, setValidating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0 });

  const handleDownloadTemplate = () => {
    // Direct API call to trigger template streaming
    api.get('/inventory/items-bulk/template', { responseType: 'blob' })
      .then((res) => {
        const url = window.URL.createObjectURL(new Blob([res.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', 'items_bulk_upload_template.csv');
        document.body.appendChild(link);
        link.click();
        link.parentNode.removeChild(link);
        message.success('Template downloaded successfully');
      })
      .catch((err) => {
        message.error('Failed to download template: ' + getErrorMessage(err));
      });
  };

  const beforeUpload = (file) => {
    const isCsv = file.type === 'text/csv' || file.name.endsWith('.csv');
    if (!isCsv) {
      message.error('You can only upload CSV files!');
      return Upload.LIST_IGNORE;
    }
    setFileList([file]);
    handleValidate(file);
    return false; // Prevent auto-upload
  };

  const handleRemove = () => {
    setFileList([]);
    setValidationResult(null);
  };

  const handleValidate = async (file) => {
    setValidating(true);
    setValidationResult(null);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('dry_run', 'true');

    try {
      const res = await api.post('/inventory/items-bulk/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120000, // Extend timeout to 2 minutes for validation
      });
      setValidationResult(res.data);
      if (res.data.success) {
        message.success('CSV validation successful! All rows are valid.');
      } else {
        message.warning('CSV validation found errors. Please review the table below.');
      }
    } catch (err) {
      console.error(err);
      let errorMsg = 'Validation failed';
      if (err.response?.data?.detail) {
        const detail = err.response.data.detail;
        if (typeof detail === 'object' && detail.message) {
          errorMsg = detail.message;
          if (detail.report) {
            setValidationResult(detail);
          }
        } else if (typeof detail === 'string') {
          errorMsg = detail;
        } else {
          errorMsg = JSON.stringify(detail);
        }
      } else {
        errorMsg = getErrorMessage(err);
      }
      message.error(errorMsg);
    } finally {
      setValidating(false);
    }
  };

  const readFileAsText = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = (e) => reject(e);
      reader.readAsText(file);
    });
  };

  const handleImport = async () => {
    if (fileList.length === 0) return;
    setImporting(true);
    setImportProgress({ current: 0, total: 0 });

    try {
      const text = await readFileAsText(fileList[0]);
      const lines = splitCsvIntoRows(text);
      if (lines.length <= 1) {
        message.error('CSV file has no data rows.');
        setImporting(false);
        return;
      }

      const header = lines[0];
      const dataLines = lines.slice(1);
      
      const validRowsReports = validationResult && validationResult.report 
        ? validationResult.report.filter(r => r.status === 'valid')
        : [];
        
      setImportProgress({ current: 0, total: validRowsReports.length });

      let successCount = 0;
      const failedRows = [];

      for (let i = 0; i < validRowsReports.length; i++) {
        const r = validRowsReports[i];
        const rowContent = dataLines[r.row_index - 1];
        const csvContent = `${header}\n${rowContent}`;
        const fileBlob = new Blob([csvContent], { type: 'text/csv' });
        const file = new File([fileBlob], `row_${r.row_index}.csv`, { type: 'text/csv' });

        const formData = new FormData();
        formData.append('file', file);
        formData.append('dry_run', 'false');

        try {
          await api.post('/inventory/items-bulk/upload', formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
            timeout: 60000, // 1 minute per item
          });
          successCount++;
          setImportProgress((prev) => ({ ...prev, current: i + 1 }));
        } catch (err) {
          console.error(`Failed to import row ${r.row_index}:`, err);
          let errorMsg = 'Import failed';
          if (err.response?.data?.detail) {
            const detail = err.response.data.detail;
            if (typeof detail === 'object' && detail.message) {
              errorMsg = detail.message;
            } else if (typeof detail === 'string') {
              errorMsg = detail;
            } else {
              errorMsg = JSON.stringify(detail);
            }
          } else {
            errorMsg = getErrorMessage(err);
          }
          failedRows.push({ rowNum: r.row_index, error: errorMsg });
          break; // Stop sequential upload on first failure
        }
      }

      if (failedRows.length > 0) {
        message.error(`Import stopped. Successfully imported ${successCount} items. Row ${failedRows[0].rowNum} failed: ${failedRows[0].error}`);
      } else {
        message.success(`Successfully imported all ${successCount} items.`);
        setFileList([]);
        setValidationResult(null);
        onUploadSuccess();
        onClose();
      }
    } catch (err) {
      console.error(err);
      message.error('Failed to parse CSV file: ' + getErrorMessage(err));
    } finally {
      setImporting(false);
    }
  };

  const reportColumns = [
    {
      title: 'Row',
      dataIndex: 'row_index',
      key: 'row_index',
      width: 70,
      align: 'center',
    },
    {
      title: 'Item Name',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
    },
    {
      title: 'Validation Status',
      dataIndex: 'status',
      key: 'status',
      width: 140,
      align: 'center',
      render: (status) => {
        const color = status === 'valid' ? 'green' : 'red';
        const label = status === 'valid' ? 'Valid' : 'Invalid';
        return <Tag color={color}>{label.toUpperCase()}</Tag>;
      },
    },
    {
      title: 'Errors / Warnings',
      key: 'messages',
      render: (_, record) => {
        const errors = record.errors || [];
        const warnings = record.warnings || [];
        return (
          <Space direction="vertical" size={2}>
            {errors.map((err, i) => (
              <span key={`e-${i}`} style={{ color: '#ff4d4f', fontSize: '12px' }}>
                <CloseCircleOutlined /> {err}
              </span>
            ))}
            {warnings.map((warn, i) => (
              <span key={`w-${i}`} style={{ color: '#faad14', fontSize: '12px' }}>
                <ExclamationCircleOutlined /> {warn}
              </span>
            ))}
            {errors.length === 0 && warnings.length === 0 && (
              <span style={{ color: '#52c41a', fontSize: '12px' }}>
                <CheckCircleOutlined /> Ready to import
              </span>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <Modal
      open={open}
      onCancel={() => {
        if (!importing) {
          handleRemove();
          onClose();
        }
      }}
      title={null}
      footer={null}
      centered
      width={720}
      styles={{ body: { padding: 0 } }}
      style={{ borderRadius: 24, overflow: 'hidden' }}
    >
      <div style={{
        background: 'linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)',
        padding: '36px 32px',
        color: '#1e293b',
        position: 'relative',
        overflow: 'hidden'
      }}>
        {/* Glow Effects */}
        <div style={{
          position: 'absolute',
          top: '-80px',
          right: '-80px',
          width: '200px',
          height: '200px',
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(37, 99, 235, 0.05) 0%, transparent 70%)',
          filter: 'blur(20px)',
          pointerEvents: 'none'
        }} />
        <div style={{
          position: 'absolute',
          bottom: '-80px',
          left: '-80px',
          width: '200px',
          height: '200px',
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(37, 99, 235, 0.05) 0%, transparent 70%)',
          filter: 'blur(20px)',
          pointerEvents: 'none'
        }} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div>
            <h2 style={{ color: '#0f172a', margin: 0, fontSize: '22px', fontWeight: 700 }}>
              Bulk Upload Items
            </h2>
            <p style={{ color: '#475569', margin: 0, fontSize: '13px' }}>
              Import item master details using a CSV spreadsheet
            </p>
          </div>
          <Button
            type="link"
            icon={<DownloadOutlined />}
            onClick={handleDownloadTemplate}
            style={{ color: '#2563eb', border: '1px solid rgba(37, 99, 235, 0.3)', borderRadius: 8, height: 38 }}
          >
            Download CSV Template
          </Button>
        </div>

        <div style={{ marginBottom: 24 }}>
          {importing ? (
            <div style={{
              background: '#ffffff',
              border: '1px solid #cbd5e1',
              borderRadius: 16,
              padding: '36px',
              textAlign: 'center',
            }}>
              <Progress
                type="circle"
                percent={importProgress.total > 0 ? Math.round((importProgress.current / importProgress.total) * 100) : 0}
                status="active"
                strokeWidth={8}
                strokeColor={{
                  '0%': '#2563eb',
                  '100%': '#4f46e5',
                }}
              />
              <h3 style={{ color: '#0f172a', margin: '20px 0 4px 0', fontSize: '16px', fontWeight: 600 }}>
                Importing items... ({importProgress.current} of {importProgress.total})
              </h3>
              <p style={{ color: '#475569', fontSize: '13px', margin: 0 }}>
                Uploading items synchronously one-by-one to prevent server timeouts and database lock delays.
              </p>
            </div>
          ) : (
            <Dragger
              accept=".csv"
              fileList={fileList}
              beforeUpload={beforeUpload}
              onRemove={handleRemove}
              showUploadList={true}
              style={{
                background: '#ffffff',
                border: '2px dashed #cbd5e1',
                borderRadius: 16,
                padding: '24px'
              }}
            >
              <p className="ant-upload-drag-icon" style={{ color: '#2563eb', fontSize: 40, marginBottom: 8 }}>
                {validating ? <LoadingOutlined /> : <CloudUploadOutlined />}
              </p>
              <p style={{ color: '#0f172a', fontSize: '15px', fontWeight: 600, margin: '0 0 4px 0' }}>
                {validating ? 'Analyzing file structure...' : 'Click or drag CSV file here to upload'}
              </p>
              <p style={{ color: '#475569', fontSize: '12px', margin: 0 }}>
                Ensure columns match the standard template schema. Level 1, 2, and 3 categories are mandatory.
              </p>
            </Dragger>
          )}
        </div>

        {/* Validation Summary and Reports */}
        {!importing && validationResult && (
          <div style={{ marginBottom: 24 }}>
            <div style={{
              display: 'flex',
              gap: 16,
              background: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: 12,
              padding: '16px',
              marginBottom: 16
            }}>
              <div>
                <span style={{ color: '#64748b', fontSize: 11, textTransform: 'uppercase' }}>Total Rows</span>
                <h3 style={{ color: '#0f172a', margin: 0, fontSize: 20 }}>{validationResult.total_rows}</h3>
              </div>
              <div style={{ borderLeft: '1px solid #e2e8f0', paddingLeft: 16 }}>
                <span style={{ color: '#16a34a', fontSize: 11, textTransform: 'uppercase' }}>Valid Rows</span>
                <h3 style={{ color: '#16a34a', margin: 0, fontSize: 20 }}>{validationResult.valid_rows}</h3>
              </div>
              <div style={{ borderLeft: '1px solid #e2e8f0', paddingLeft: 16 }}>
                <span style={{ color: '#dc2626', fontSize: 11, textTransform: 'uppercase' }}>Invalid Rows</span>
                <h3 style={{ color: '#dc2626', margin: 0, fontSize: 20 }}>{validationResult.error_rows}</h3>
              </div>
            </div>

            <div style={{
              background: '#ffffff',
              borderRadius: 12,
              border: '1px solid #e2e8f0',
              maxHeight: 240,
              overflowY: 'auto'
            }}>
              <Table
                dataSource={validationResult.report}
                columns={reportColumns}
                rowKey="row_index"
                pagination={false}
                size="small"
                style={{
                  background: 'transparent',
                }}
              />
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 12 }}>
          <Button
            onClick={() => {
              handleRemove();
              onClose();
            }}
            disabled={importing}
            style={{
              background: '#ffffff',
              border: '1px solid #cbd5e1',
              color: '#334155',
              borderRadius: 10,
              height: 40,
            }}
          >
            Cancel
          </Button>
          <Button
            type="primary"
            onClick={handleImport}
            loading={importing}
            disabled={
              fileList.length === 0 ||
              validating ||
              (validationResult && validationResult.valid_rows === 0)
            }
            style={{
              background: 'linear-gradient(90deg, #2563eb 0%, #4f46e5 100%)',
              border: 0,
              color: '#fff',
              borderRadius: 10,
              height: 40,
              fontWeight: 600,
              boxShadow: fileList.length > 0 ? '0 4px 12px rgba(37,99,235,0.2)' : 'none',
            }}
          >
            Import Items ({validationResult ? validationResult.valid_rows : 0})
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default BulkUploadModal;
