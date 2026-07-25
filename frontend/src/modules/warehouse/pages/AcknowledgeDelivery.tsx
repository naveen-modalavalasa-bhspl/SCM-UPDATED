// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button, Form, Input, InputNumber, Select, Space, Card, Row, Col,
  Table, Divider, Typography, Tag, Spin, App, Upload, Image, Alert, Collapse, Descriptions, Tooltip
} from 'antd';
import {
  ArrowLeftOutlined, CheckCircleOutlined, UploadOutlined,
  SearchOutlined, BarcodeOutlined, GiftOutlined, EnvironmentOutlined,
  PictureOutlined, SafetyCertificateOutlined, AlertOutlined, QrcodeOutlined
} from '@ant-design/icons';
import { QRCodeSVG } from 'qrcode.react';
import api from '../config/api';
import PageHeader from '../components/PageHeader';
import { formatNumber, formatDate } from '../utils/helpers';
import useAuthStore from '../store/authStore';

const { TextArea } = Input;
const { Title, Text } = Typography;
const { Option } = Select;
import AssetCodesTreeModal from '../components/AssetCodesTreeModal';
const { Panel } = Collapse;

const AcknowledgeDelivery = () => {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryBarcode = searchParams.get('barcode');

  const [form] = Form.useForm();
  const user = useAuthStore(s => s.user);

  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Search/Scan state
  const [barcodeInput, setBarcodeInput] = useState('');
  const [activeScanType, setActiveScanType] = useState(null); // 'parent' or 'child'
  const [consignmentData, setConsignmentData] = useState(null);
  const [packageData, setPackageData] = useState(null);
  const [scannedItemInfo, setScannedItemInfo] = useState(null);

  // SCM lookup states
  const [warehouses, setWarehouses] = useState([]);
  const [selectedWarehouseId, setSelectedWarehouseId] = useState(null);
  const [uploadedUrls, setUploadedUrls] = useState({});

  // Modal states for selectable serial numbers in delivery acknowledgement
  const [modalOpen, setModalOpen] = useState(false);
  const [activeRow, setActiveRow] = useState(null);

  const mockRawRows = React.useMemo(() => {
    if (!activeRow) return [];
    const pool = activeRow.serial_numbers || [];
    return [{
      location: 'Packed Package',
      bin_name: 'Package Area',
      batch_number: activeRow.batch_number || 'Packed Batch',
      expiry_date: activeRow.expiry_date,
      mfg_date: activeRow.mfg_date,
      serial_numbers: pool,
      asset_codes: pool,
      consumable_codes: pool,
    }];
  }, [activeRow]);

  const handleSaveModalCodes = (selected) => {
    if (activeRow) {
      form.setFieldsValue({
        [`serials_rec_${activeRow.id}`]: selected,
        [`qty_rec_${activeRow.id}`]: selected.length,
        [`qty_acc_${activeRow.id}`]: selected.length,
      });
    }
    setModalOpen(false);
    setActiveRow(null);
  };

  // Fetch initial warehouses list
  useEffect(() => {
    const fetchMasters = async () => {
      try {
        setLoading(true);
        const warehouseRes = await api.get('/masters/warehouses', { params: { page_size: 200 } });
        const whsList = warehouseRes.data?.items || warehouseRes.data?.data || warehouseRes.data || [];
        setWarehouses(whsList);

        if (user && user.warehouse_id) {
          setSelectedWarehouseId(user.warehouse_id);
        } else if (whsList.length > 0) {
          setSelectedWarehouseId(whsList[0].id);
        }
      } catch (err) {
        message.error("Failed to load warehouses.");
      } finally {
        setLoading(false);
      }
    };
    fetchMasters();
  }, [user, message]);

  // Pre-fill barcode from URL query param if present
  useEffect(() => {
    if (queryBarcode) {
      setBarcodeInput(queryBarcode);
      handleScan(queryBarcode);
    }
  }, [queryBarcode]);

  // Pre-fill user info in form
  useEffect(() => {
    if (user) {
      form.setFieldsValue({
        acknowledged_by_name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.username || '',
        acknowledged_by_employee_code: user.employee_code || '',
        acknowledged_by_designation: user.designation || 'Warehouse operator',
        acknowledged_by_department: user.department || 'SCM',
        acknowledged_by_phone: user.phone || '9998880000',
      });
    }
  }, [user, form]);

  const handleScan = async (code = barcodeInput) => {
    if (!code) {
      message.warning('Please enter or scan a package/parent barcode.');
      return;
    }
    setLoading(true);
    setConsignmentData(null);
    setPackageData(null);
    setActiveScanType(null);
    setScannedItemInfo(null);

    let parsedCode = code.trim();
    if (parsedCode.includes(' - ')) {
      parsedCode = parsedCode.split(' - ')[0].trim();
    }
    if (parsedCode.includes('\n')) {
      const lines = parsedCode.split('\n');
      const codeLine = lines.find(l => l.trim().startsWith('Code:'));
      if (codeLine) {
        parsedCode = codeLine.replace('Code:', '').trim();
      } else {
        const matLine = lines.find(l => l.trim().startsWith('Material:'));
        if (matLine) {
          parsedCode = matLine.replace('Material:', '').trim();
        }
      }
    }

    try {
      const res = await api.get(`/consignment/scan-any/${encodeURIComponent(parsedCode)}`);
      if (res.data) {
        const { type, data, scanned_item } = res.data;
        if (scanned_item) {
          setScannedItemInfo(scanned_item);
        }
        if (type === 'parent') {
          setConsignmentData(data);
          setActiveScanType('consignment');
          message.success('Consignment details loaded successfully.');
          form.setFieldsValue({
            acknowledged_by_name: data.receiver_name || form.getFieldValue('acknowledged_by_name'),
            acknowledged_by_employee_code: data.receiver_employee_code || form.getFieldValue('acknowledged_by_employee_code'),
            acknowledged_by_designation: data.receiver_position_code || form.getFieldValue('acknowledged_by_designation'),
          });
        } else if (type === 'child') {
          setPackageData(data);
          setActiveScanType('package');
          message.success('Package details loaded successfully.');
          form.setFieldsValue({
            acknowledged_by_name: data.receiver_name || form.getFieldValue('acknowledged_by_name'),
            acknowledged_by_employee_code: data.receiver_employee_code || form.getFieldValue('acknowledged_by_employee_code'),
            acknowledged_by_designation: data.receiver_position_code || form.getFieldValue('acknowledged_by_designation'),
          });
        }
      }
    } catch (err) {
      message.error(err.response?.data?.detail || 'Barcode not recognized. Please scan a valid consignment or package code.');
    } finally {
      setLoading(false);
    }
  };

  const handleUploadFile = async (file, fieldKey) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('entity_type', 'general');
    try {
      const response = await api.post('/attachments/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      const data = response.data;
      const uploadedUrl = data.url || data.file_path || '';
      setUploadedUrls((prev) => ({ ...prev, [fieldKey]: uploadedUrl }));
      form.setFieldsValue({ [fieldKey]: uploadedUrl });
      message.success(`${file.name} uploaded successfully.`);
      return uploadedUrl;
    } catch (error) {
      console.error(error);
      message.error(`${file.name} upload failed.`);
      throw error;
    }
  };

  const handleSubmit = async () => {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;

    if (!uploadedUrls.signature_image) {
      message.error('Signature / Stamp upload is mandatory!');
      return;
    }

    setSubmitting(true);
    try {
      if (activeScanType === 'package') {
        // Enforce that selected serials match Accepted Qty
        for (const item of packageData.items || []) {
          if (item.serial_numbers && item.serial_numbers.length > 0) {
            const qtyAcc = values[`qty_acc_${item.id}`] !== undefined ? values[`qty_acc_${item.id}`] : item.quantity_packed;
            const serialsRcvd = values[`serials_rec_${item.id}`] !== undefined ? values[`serials_rec_${item.id}`] : (item.serial_numbers || []);
            if (serialsRcvd.length !== qtyAcc) {
              message.error(`Please select exactly ${qtyAcc} serial/asset code(s) for ${item.material_name}. Currently selected: ${serialsRcvd.length}`);
              setSubmitting(false);
              return;
            }
          }
        }

        // Prepare single package payload
        const payload = {
          package_id: packageData.id,
          acknowledged_by_name: values.acknowledged_by_name,
          acknowledged_by_designation: values.acknowledged_by_designation || 'Storekeeper',
          acknowledged_by_phone: values.acknowledged_by_phone,
          acknowledged_by_employee_code: values.acknowledged_by_employee_code,
          receiver_signature_url: uploadedUrls.signature_image,
          photos: uploadedUrls.materials_photos ? [uploadedUrls.materials_photos] : [],
          remarks: values.remarks || 'Received successfully',
          packaging_condition: values.packaging_condition || 'INTACT',
          seal_intact: values.seal_intact !== false,
          seal_number_verified: !!packageData.seal_number,
          latitude: null,
          longitude: null,
          geo_fence_verified: false,
          device_id: 'WEB_PORTAL',
          ip_address: '127.0.0.1',
          items: (packageData.items || []).map(item => {
            const qtyRec = values[`qty_rec_${item.id}`] !== undefined ? values[`qty_rec_${item.id}`] : item.quantity_packed;
            const qtyAcc = values[`qty_acc_${item.id}`] !== undefined ? values[`qty_acc_${item.id}`] : qtyRec;
            const serialsRcvd = values[`serials_rec_${item.id}`] !== undefined ? values[`serials_rec_${item.id}`] : (item.serial_numbers || []);
            return {
              package_item_id: item.id,
              quantity_received: qtyRec,
              quantity_accepted: qtyAcc,
              quantity_rejected: Math.max(0, qtyRec - qtyAcc),
              quantity_damaged: 0,
              item_condition: values[`condition_${item.id}`] || 'GOOD',
              serial_numbers_received: serialsRcvd,
            };
          }),
        };

        await api.post('/consignment/acknowledge', payload);
        message.success('Package delivery acknowledged successfully!');
        navigate('/logistics/consignments');
      } else if (activeScanType === 'consignment') {
        // Mark consignment as delivered with POD evidence
        const payload = {
          receiver_signature_url: uploadedUrls.signature_image || null,
          photos: uploadedUrls.materials_photos ? [uploadedUrls.materials_photos] : [],
          remarks: values.remarks || 'Received successfully',
          acknowledged_by_name: values.acknowledged_by_name,
          acknowledged_by_designation: values.acknowledged_by_designation || 'Storekeeper',
          acknowledged_by_phone: values.acknowledged_by_phone,
          acknowledged_by_employee_code: values.acknowledged_by_employee_code,
        };
        await api.post(`/consignment/${consignmentData.id}/deliver`, payload);
        message.success('Consignment marked as DELIVERED successfully!');
        navigate('/logistics/consignments');
      }
    } catch (err) {
      console.error(err);
      message.error(err.response?.data?.detail || 'Failed to submit receipt acknowledgement.');
    } finally {
      setSubmitting(false);
    }
  };

  const getStatusValidation = () => {
    if (activeScanType === 'package' && packageData) {
      if (['UNPACKED', 'PARTIALLY_UNPACKED', 'RECEIVED', 'PARTIALLY_RECEIVED'].includes(packageData.status)) {
        return { disabled: true, text: 'Package Already Unpacked', type: 'success', message: 'Already Acknowledged', description: `This package (${packageData.package_number}) has already been unpacked and acknowledged (${packageData.status}).` };
      }
      if (packageData.status === 'DRAFT') {
        return { disabled: true, text: 'Cannot Acknowledge (DRAFT)', type: 'warning', message: 'Not Dispatched Yet', description: `This package (${packageData.package_number}) is in DRAFT status and has not been dispatched yet.` };
      }
      // Enforce two-step: check parent consignment status from packageData
      const parentStatus = packageData.consignment_status;
      if (parentStatus && !['CONSIGNMENT_RECEIVED', 'PARTIALLY_UNPACKED'].includes(parentStatus)) {
        return {
          disabled: true,
          text: 'Acknowledge Consignment First',
          type: 'warning',
          message: 'Consignment Not Yet Acknowledged',
          description: `Please scan consignment ${packageData.consignment_number || ''} and confirm its delivery before acknowledging individual packages. Current consignment status: '${parentStatus}'.`
        };
      }
      if (!['PACKED', 'IN_TRANSIT', 'DELIVERED', 'CONSIGNMENT_RECEIVED'].includes(packageData.status)) {
        return { disabled: true, text: `Cannot Acknowledge (${packageData.status})`, type: 'error', message: 'Invalid Status', description: `Cannot acknowledge package in '${packageData.status}' status.` };
      }
      return { disabled: false, text: 'Acknowledge Package & Sync Stock' };
    }
    if (activeScanType === 'consignment' && consignmentData) {
      if (['UNPACKED', 'RECEIVED'].includes(consignmentData.status)) {
        return { disabled: true, text: 'All Packages Unpacked', type: 'success', message: 'Fully Received', description: `All packages in consignment ${consignmentData.consignment_number} have been unpacked and acknowledged.` };
      }
      if (consignmentData.status === 'PARTIALLY_UNPACKED') {
        return { disabled: true, text: 'Partially Unpacked — Scan Packages', type: 'info', message: 'Partially Unpacked', description: `Some packages in ${consignmentData.consignment_number} have been unpacked. Scan individual packages to continue.` };
      }
      if (consignmentData.status === 'CONSIGNMENT_RECEIVED') {
        return { disabled: true, text: 'Consignment Already Received', type: 'success', message: 'Delivery Confirmed', description: `Consignment ${consignmentData.consignment_number} has been received. Scan individual packages to unpack and sync inventory.` };
      }
      if (consignmentData.status === 'DRAFT') {
        return { disabled: true, text: 'Cannot Deliver (DRAFT)', type: 'warning', message: 'Not Dispatched Yet', description: `This consignment (${consignmentData.consignment_number}) is in DRAFT status and has not been dispatched yet.` };
      }
      if (!['PACKED', 'IN_TRANSIT'].includes(consignmentData.status)) {
        return { disabled: true, text: `Cannot Deliver (${consignmentData.status})`, type: 'error', message: 'Invalid Status', description: `Cannot transition consignment in '${consignmentData.status}' status.` };
      }
      return { disabled: false, text: 'Confirm Consignment Delivery' };
    }
    return { disabled: true, text: 'Acknowledge & Sync Stock' };
  };

  const validation = getStatusValidation();
  const isActionDisabled = validation.disabled;

  return (
    <div style={{ padding: '28px', background: 'radial-gradient(ellipse at top, #f8fafc 0%, #f1f5f9 80%)', minHeight: '100vh', color: '#334155' }}>
      <PageHeader
        title="Delivery Acknowledgement"
        subtitle="Packaging-wise receipt, barcode/QR scans, digital signature uploads, and instant stock ledger postings."
      >
        <Space>
          <Button onClick={() => navigate('/logistics/consignments')} icon={<ArrowLeftOutlined />}>
            Back to Consignments
          </Button>
          {(consignmentData || packageData) && (
            <Button
              type="primary"
              icon={<CheckCircleOutlined />}
              loading={submitting}
              disabled={isActionDisabled}
              onClick={handleSubmit}
              style={{
                background: isActionDisabled ? '#cbd5e1' : 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                borderColor: 'transparent',
                fontWeight: 'bold',
                color: isActionDisabled ? '#94a3b8' : '#ffffff',
                cursor: isActionDisabled ? 'not-allowed' : 'pointer'
              }}
            >
              {validation.text}
            </Button>
          )}
        </Space>
      </PageHeader>

      <Form form={form} layout="vertical" style={{ width: '100%' }}>
        <Row gutter={[20, 20]}>
        {/* Step 1: Operating Location & Scan Input */}
        <Col span={24}>
          <Card
            title={<span style={{ color: '#0f172a', fontWeight: 800 }}><BarcodeOutlined style={{ marginRight: 8, color: '#4f46e5' }} />Scan Barcode or QR Code</span>}
            size="small"
            style={{ borderRadius: '12px', border: '1px solid #cbd5e1', boxShadow: '0 4px 12px rgba(0,0,0,0.03)' }}
          >
            <Row gutter={24} align="middle">
              <Col xs={24} md={10}>
                <Form.Item label={<span style={{ color: '#475569', fontWeight: 600 }}>Operating Warehouse</span>} style={{ marginBottom: 0 }}>
                  <Select
                    showSearch
                    placeholder="Select operating warehouse location..."
                    value={selectedWarehouseId}
                    onChange={(val) => setSelectedWarehouseId(val)}
                    options={warehouses.map(w => ({ label: `${w.name} (${w.code})`, value: w.id }))}
                    style={{ width: '100%' }}
                    filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
                  />
                </Form.Item>
              </Col>

              <Col xs={24} md={14}>
                <Form.Item label={<span style={{ color: '#4f46e5', fontWeight: 700 }}>Scan Consignment or Package Code</span>} style={{ marginBottom: 0 }}>
                  <Input.Search
                    placeholder="Scan consignment barcode (e.g. CON-AP-...) or package barcode (e.g. PKG-AP-...)"
                    value={barcodeInput}
                    onChange={(e) => setBarcodeInput(e.target.value)}
                    onSearch={() => handleScan()}
                    enterButton={
                      <Button type="primary" style={{ background: '#4f46e5', borderColor: '#4f46e5' }}>
                        Load Package
                      </Button>
                    }
                    loading={loading}
                    size="large"
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              </Col>
            </Row>
          </Card>
        </Col>

        {loading && (
          <Col span={24} style={{ textAlign: 'center', padding: '40px' }}>
            <Spin size="large" tip="Reading scanned barcode details...">
              <div style={{ minHeight: '30px' }} />
            </Spin>
          </Col>
        )}

        {/* ── Scanned Item Details Alert ── */}
        {!loading && scannedItemInfo && (
          <Col span={24}>
            <Card
              size="small"
              style={{
                borderRadius: '12px',
                border: '2px solid #38bdf8',
                background: 'linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%)',
                boxShadow: '0 4px 12px rgba(56, 189, 248, 0.15)',
                marginBottom: '16px'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <div style={{
                  width: 48, height: 48, borderRadius: '10px',
                  background: 'linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: '0 4px 6px rgba(14, 165, 233, 0.2)'
                }}>
                  <QrcodeOutlined style={{ color: '#fff', fontSize: 24 }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '12px', color: '#0369a1', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Scanned Asset / Consumable Details
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '24px', marginTop: '4px' }}>
                    <div>
                      <Text type="secondary" style={{ fontSize: '11px', display: 'block' }}>Scanned Code</Text>
                      <Text strong style={{ fontFamily: 'monospace', fontSize: '14px', color: '#0f172a' }}>{scannedItemInfo.code}</Text>
                    </div>
                    {scannedItemInfo.item_name && (
                      <div>
                        <Text type="secondary" style={{ fontSize: '11px', display: 'block' }}>Item</Text>
                        <Text strong style={{ fontSize: '13px', color: '#0f172a' }}>{scannedItemInfo.item_name} ({scannedItemInfo.item_code})</Text>
                      </div>
                    )}
                    {scannedItemInfo.mfg_date && (
                      <div>
                        <Text type="secondary" style={{ fontSize: '11px', display: 'block' }}>Manufacture Date</Text>
                        <Text strong style={{ fontSize: '13px', color: '#0f172a' }}>{scannedItemInfo.mfg_date}</Text>
                      </div>
                    )}
                    {scannedItemInfo.warranty_expiry && (
                      <div>
                        <Text type="secondary" style={{ fontSize: '11px', display: 'block' }}>Warranty Expiry</Text>
                        <Tag color="blue" style={{ fontWeight: 700, marginTop: '2px' }}>{scannedItemInfo.warranty_expiry}</Tag>
                      </div>
                    )}
                    {scannedItemInfo.expiry_date && (
                      <div>
                        <Text type="secondary" style={{ fontSize: '11px', display: 'block' }}>Expiry Date</Text>
                        <Tag color="volcano" style={{ fontWeight: 700, marginTop: '2px' }}>{scannedItemInfo.expiry_date}</Tag>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          </Col>
        )}

        {/* ── Case A: Consignment Scanned ── */}
        {activeScanType === 'consignment' && consignmentData && (
          <Col span={24}>
            <Row gutter={[20, 20]}>
              {['CONSIGNMENT_RECEIVED', 'UNPACKED', 'PARTIALLY_UNPACKED', 'RECEIVED', 'PARTIALLY_RECEIVED'].includes(consignmentData.status) && (
                <Col span={24}>
                  <Alert
                    message={
                      consignmentData.status === 'CONSIGNMENT_RECEIVED' ? "Step 1 Complete — Confirm Individual Packages"
                      : consignmentData.status === 'UNPACKED' ? "All Packages Unpacked"
                      : consignmentData.status === 'PARTIALLY_UNPACKED' ? "Partially Unpacked — Scan Remaining Packages"
                      : "Already Acknowledged"
                    }
                    description={
                      consignmentData.status === 'CONSIGNMENT_RECEIVED'
                        ? `Consignment ${consignmentData.consignment_number} has been received. Now scan each package individually to record accepted/rejected quantities and synchronize inventory.`
                        : consignmentData.status === 'UNPACKED'
                        ? `All packages in consignment ${consignmentData.consignment_number} have been unpacked and stock has been posted to the destination warehouse.`
                        : consignmentData.status === 'PARTIALLY_UNPACKED'
                        ? `Some packages in ${consignmentData.consignment_number} have been unpacked. Scan remaining packages to complete the process.`
                        : `This consignment (${consignmentData.consignment_number}) has already been acknowledged and received.`
                    }
                    type={['CONSIGNMENT_RECEIVED', 'PARTIALLY_UNPACKED'].includes(consignmentData.status) ? 'info' : 'success'}
                    showIcon
                    style={{ borderRadius: '12px' }}
                  />
                </Col>
              )}
              <Col span={24}>
                <Alert
                  message="Consignment Scanned"
                  description={
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <div>Scanned code matches Consignment: <strong>{consignmentData.consignment_number}</strong>. Click <strong>Confirm Consignment Delivery</strong> to mark the consignment as received (Step 1). Then scan individual packages to unpack and sync inventory (Step 2).</div>
                      <div style={{ background: '#ffffff', padding: '6px 12px', borderRadius: '6px', border: '1px solid #e2e8f0', display: 'inline-block', width: 'fit-content' }}>
                        👤 <strong>Expected Receiver:</strong> {consignmentData.receiver_name || '—'} ({consignmentData.receiver_employee_code || '—'}) 
                        <Divider type="vertical" />
                        💼 <strong>Position Code:</strong> <Tag color="purple">{consignmentData.receiver_position_code || '—'}</Tag>
                      </div>
                    </div>
                  }
                  type="info"
                  showIcon
                  style={{ borderRadius: '12px' }}
                />
              </Col>

              <Col xs={24} md={24}>
                <Card title="Consignment Hierarchy & Packages" style={{ borderRadius: '12px', border: '1px solid #cbd5e1' }}>
                  <Collapse 
                    defaultActiveKey={['0']} 
                    expandIconPosition="end" 
                    items={(consignmentData.packages || []).map((pkg, idx) => ({
                      key: idx.toString(),
                      label: (
                        <Space>
                          <GiftOutlined style={{ color: '#4f46e5' }} />
                          <strong>{pkg.package_number}</strong>
                          <Tag color="blue">{pkg.package_type}</Tag>
                          <span style={{ fontSize: '12px', color: '#64748b' }}>Weight: {pkg.gross_weight_kg || 0} kg</span>
                        </Space>
                      ),
                      children: (
                        <div>
                          <Descriptions column={2} size="small" style={{ marginBottom: 12 }}>
                            <Descriptions.Item label="Seal Number">{pkg.seal_number || 'No Seal'}</Descriptions.Item>
                            <Descriptions.Item label="Items Count">{pkg.material_count || 0}</Descriptions.Item>
                            <Descriptions.Item label="Package Status"><Tag>{pkg.status}</Tag></Descriptions.Item>
                          </Descriptions>
                          <div style={{ padding: '8px', background: '#f8fafc', borderRadius: '8px', fontSize: '12px', color: '#475569' }}>
                            ℹ️ All items inside this package will be bulk accepted at packed quantity on submit.
                          </div>
                        </div>
                      )
                    }))}
                  />
                </Card>
              </Col>
            </Row>
          </Col>
        )}

        {/* ── Case B: Single Package Scanned ── */}
        {activeScanType === 'package' && packageData && (
          <Col span={24}>
            <Row gutter={[20, 20]}>
              {['UNPACKED', 'PARTIALLY_UNPACKED', 'RECEIVED', 'PARTIALLY_RECEIVED'].includes(packageData.status) && (
                <Col span={24}>
                  <Alert
                    message="Package Already Unpacked"
                    description={`This package (${packageData.package_number}) has already been unpacked and acknowledged (${packageData.status}).`}
                    type="success"
                    showIcon
                    style={{ borderRadius: '12px' }}
                  />
                </Col>
              )}
              {packageData.consignment_status && !['CONSIGNMENT_RECEIVED', 'PARTIALLY_UNPACKED'].includes(packageData.consignment_status) && !['UNPACKED', 'PARTIALLY_UNPACKED', 'RECEIVED', 'PARTIALLY_RECEIVED'].includes(packageData.status) && (
                <Col span={24}>
                  <Alert
                    message="Step 1 Required: Acknowledge Consignment First"
                    description={`Consignment ${packageData.consignment_number || ''} must be acknowledged as received before you can unpack individual packages. Current consignment status: '${packageData.consignment_status}'. Scan the consignment barcode first.`}
                    type="warning"
                    showIcon
                    style={{ borderRadius: '12px' }}
                  />
                </Col>
              )}
              <Col span={24}>
                <Card title={<span><GiftOutlined style={{ color: '#4f46e5', marginRight: 8 }} />Package Manifest: {packageData.package_number}</span>} style={{ borderRadius: '12px', border: '1px solid #cbd5e1' }}>
                  <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
                    <Col xs={12} md={4}>
                      <Text type="secondary">Package Number</Text>
                      <div style={{ fontWeight: 700, fontFamily: 'monospace' }}>{packageData.package_number}</div>
                    </Col>
                    <Col xs={12} md={4}>
                      <Text type="secondary">Package Type</Text>
                      <div><Tag color="cyan">{packageData.package_type}</Tag></div>
                    </Col>
                    <Col xs={12} md={4}>
                      <Text type="secondary">Expected Receiver</Text>
                      <div style={{ fontWeight: 600 }}>{packageData.receiver_name || '—'} ({packageData.receiver_employee_code || '—'})</div>
                    </Col>
                    <Col xs={12} md={4}>
                      <Text type="secondary">Receiver Position</Text>
                      <div><Tag color="purple">{packageData.receiver_position_code || '—'}</Tag></div>
                    </Col>
                    <Col xs={12} md={4}>
                      <Text type="secondary">Gross Weight</Text>
                      <div style={{ fontWeight: 600 }}>{packageData.gross_weight_kg || 0} KG</div>
                    </Col>
                    <Col xs={12} md={4}>
                      <Text type="secondary">Seal Number</Text>
                      <div style={{ fontWeight: 600 }}>{packageData.seal_number || 'N/A'}</div>
                    </Col>
                  </Row>

                  <Table
                    dataSource={packageData.items || []}
                    rowKey="id"
                    pagination={false}
                    size="small"
                    bordered
                    scroll={{ x: 1400 }}
                    columns={[
                      { title: 'Material Name', dataIndex: 'material_name', key: 'name', width: 200 },
                      { title: 'Material Code', dataIndex: 'material_code', key: 'code', width: 130, render: t => <span style={{ fontFamily: 'monospace' }}>{t}</span> },
                      { title: 'Batch', dataIndex: 'batch_number', key: 'batch', width: 90, render: t => t || '—' },
                      { title: 'Packed Qty', dataIndex: 'quantity_packed', key: 'packed_qty', width: 90, render: v => <span style={{ fontWeight: 700 }}>{v}</span> },
                      {
                        title: 'Received Qty',
                        key: 'qty_received',
                        width: 100,
                        render: (_, r) => (
                          <Form.Item name={`qty_rec_${r.id}`} initialValue={r.quantity_packed} style={{ marginBottom: 0 }}>
                            <InputNumber
                              min={0}
                              max={r.quantity_packed}
                              size="small"
                              style={{ width: '80px' }}
                              onChange={v => {
                                const accVal = form.getFieldValue(`qty_acc_${r.id}`) || 0;
                                if (accVal > (v || 0)) {
                                  form.setFieldsValue({ [`qty_acc_${r.id}`]: v || 0 });
                                  const serials = r.serial_numbers || [];
                                  if (serials.length > 0) {
                                    if (v === r.quantity_packed) {
                                      form.setFieldsValue({ [`serials_rec_${r.id}`]: r.serial_numbers });
                                    } else {
                                      form.setFieldsValue({ [`serials_rec_${r.id}`]: [] });
                                    }
                                  }
                                }
                              }}
                            />
                          </Form.Item>
                        )
                      },
                      {
                        title: 'Accepted Qty',
                        key: 'qty_accepted',
                        width: 100,
                        render: (_, r) => (
                          <Form.Item noStyle dependencies={[`qty_rec_${r.id}`]}>
                            {() => {
                              const recVal = form.getFieldValue(`qty_rec_${r.id}`) ?? r.quantity_packed;
                              return (
                                <Form.Item name={`qty_acc_${r.id}`} initialValue={r.quantity_packed} style={{ marginBottom: 0 }}>
                                  <InputNumber
                                    min={0}
                                    max={recVal}
                                    size="small"
                                    style={{ width: '80px' }}
                                    onChange={v => {
                                      const serials = r.serial_numbers || [];
                                      if (serials.length > 0) {
                                        const currentSerials = form.getFieldValue(`serials_rec_${r.id}`) || [];
                                        if (currentSerials.length !== v) {
                                          if (v === r.quantity_packed) {
                                            form.setFieldsValue({ [`serials_rec_${r.id}`]: r.serial_numbers });
                                          } else {
                                            form.setFieldsValue({ [`serials_rec_${r.id}`]: [] });
                                          }
                                        }
                                      }
                                    }}
                                  />
                                </Form.Item>
                              );
                            }}
                          </Form.Item>
                        )
                      },
                      {
                        title: 'Condition',
                        key: 'condition',
                        width: 130,
                        render: (_, r) => (
                          <Form.Item name={`condition_${r.id}`} initialValue="GOOD" style={{ marginBottom: 0 }}>
                            <Select size="small" style={{ width: '120px' }}>
                              <Option value="GOOD">Good</Option>
                              <Option value="DAMAGED">Damaged</Option>
                              <Option value="DEFECTIVE">Defective</Option>
                              <Option value="EXPIRED">Expired</Option>
                              <Option value="WRONG_ITEM">Wrong Item</Option>
                            </Select>
                          </Form.Item>
                        )
                      },
                      {
                        title: 'Serial / Asset Codes',
                        key: 'serials',
                        width: 180,
                        render: (_, r) => {
                          if (!r.serial_numbers || r.serial_numbers.length === 0) return <span style={{ color: '#94a3b8' }}>—</span>;
                          const isAsset = r.material_type === 'asset';
                          const label = isAsset ? 'Codes' : 'Serials';
                          return (
                            <Form.Item name={`serials_rec_${r.id}`} initialValue={r.serial_numbers} style={{ marginBottom: 0 }}>
                              <Form.Item noStyle dependencies={[`serials_rec_${r.id}`]}>
                                {() => {
                                  const current = form.getFieldValue(`serials_rec_${r.id}`) || [];
                                  const count = current.length;
                                  return (
                                    <Button
                                      size="small"
                                      type={count > 0 ? "primary" : "dashed"}
                                      icon={<BarcodeOutlined />}
                                      onClick={() => {
                                        setActiveRow(r);
                                        setModalOpen(true);
                                      }}
                                      style={{
                                        borderRadius: '20px',
                                        fontWeight: 600,
                                        fontSize: '11px',
                                        background: count > 0 ? '#16a34a' : undefined,
                                        borderColor: count > 0 ? '#16a34a' : undefined,
                                      }}
                                    >
                                      {count > 0 ? `${count} ${label} Received` : `Select ${label}`}
                                    </Button>
                                  );
                                }}
                              </Form.Item>
                            </Form.Item>
                          );
                        }
                      },
                      {
                        title: 'Asset/Consumable Codes',
                        key: 'asset_codes',
                        width: 320,
                        render: (_, r) => {
                          const isAsset = r.material_type === 'asset';
                          const isConsumable = r.material_type === 'consumable';
                          if (!isAsset && !isConsumable) return <span style={{ color: '#94a3b8' }}>—</span>;
                          return (
                            <Form.Item noStyle dependencies={[`serials_rec_${r.id}`]}>
                              {() => {
                                const currentSerials = form.getFieldValue(`serials_rec_${r.id}`) || r.serial_numbers || [];
                                if (currentSerials.length === 0) return <span style={{ color: '#94a3b8' }}>—</span>;
                                const matCode = r.material_code || '';
                                const prefix = matCode ? `${matCode}-1-` : '';
                                const parsed = currentSerials.map(s => {
                                  if (prefix && s.startsWith(prefix)) {
                                     return s;
                                  }
                                  return `${prefix}${s}`;
                                });

                                const visible = parsed.slice(0, 4);
                                const remainingCount = parsed.length - 4;
                                const tooltipContent = (
                                  <div style={{ maxHeight: '200px', overflowY: 'auto', padding: '4px' }}>
                                    <div style={{ fontWeight: 700, marginBottom: '6px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                      All {parsed.length} Codes:
                                    </div>
                                    <Space wrap size={[4, 4]}>
                                      {parsed.map(s => (
                                        <Tag key={s} color={isAsset ? "cyan" : "orange"} style={{ margin: 0, fontSize: '11px' }}>{s}</Tag>
                                      ))}
                                    </Space>
                                  </div>
                                );

                                return (
                                  <Tooltip title={tooltipContent} color="#0f172a" placement="topLeft" overlayStyle={{ maxWidth: '340px' }}>
                                    <Space wrap style={{ cursor: 'pointer' }}>
                                      {visible.map(s => (
                                        <Tag key={s} color={isAsset ? "cyan" : "orange"}>{s}</Tag>
                                      ))}
                                      {remainingCount > 0 && (
                                        <Tag color="default" style={{ fontWeight: 700, border: '1px dashed #cbd5e1' }}>
                                          + {remainingCount} more
                                        </Tag>
                                      )}
                                    </Space>
                                  </Tooltip>
                                );
                              }}
                            </Form.Item>
                          );
                        }
                      }
                    ]}
                  />
                </Card>
              </Col>
            </Row>
          </Col>
        )}

        {/* ── Steps 4 & 5: Receiver details, digital signature ── */}
        {(consignmentData || packageData) && (
          <>
            <Col xs={24} md={12}>
              <Card
                title={<span style={{ color: '#0f172a', fontWeight: 800 }}><SafetyCertificateOutlined style={{ marginRight: 8, color: '#10b981' }} />Signatory Details</span>}
                size="small"
                style={{ borderRadius: '12px', border: '1px solid #cbd5e1', boxShadow: '0 4px 12px rgba(0,0,0,0.03)', height: '100%' }}
              >
                  <Row gutter={16}>
                    <Col span={12}>
                      <Form.Item
                        name="acknowledged_by_name"
                        label={<span style={{ fontWeight: 600 }}>Receiver Name</span>}
                        rules={[{ required: true, message: 'Receiver name is required' }]}
                      >
                        <Input placeholder="E.g., Nilesh Patil" />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item
                        name="acknowledged_by_employee_code"
                        label={<span style={{ fontWeight: 600 }}>Receiver Emp Code</span>}
                        rules={[{ required: true, message: 'Employee code is required' }]}
                      >
                        <Input placeholder="E.g., EMP023" />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item
                        name="acknowledged_by_phone"
                        label={<span style={{ fontWeight: 600 }}>Contact Number</span>}
                        rules={[{ required: true, message: 'Phone number is required' }]}
                      >
                        <Input placeholder="E.g., 9988001122" />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="acknowledged_by_designation" label="Designation">
                        <Input placeholder="E.g., Storekeeper" />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="acknowledged_by_department" label="Department">
                        <Input placeholder="E.g., Warehouse Ops" />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="packaging_condition" label="Packaging Condition" initialValue="INTACT">
                        <Select>
                          <Option value="INTACT">Intact</Option>
                          <Option value="DAMAGED">Damaged / Broken</Option>
                        </Select>
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="seal_intact" label="Seal Intact?" valuePropName="checked" initialValue={true}>
                        <Select>
                          <Option value={true}>Yes</Option>
                          <Option value={false}>No</Option>
                        </Select>
                      </Form.Item>
                    </Col>
                    <Col span={24}>
                      <Form.Item name="remarks" label="Remarks / Discrepancy details">
                        <TextArea rows={2} placeholder="Add package remarks, condition, or short receipt notes..." />
                      </Form.Item>
                    </Col>
                  </Row>
              </Card>
            </Col>

            <Col xs={24} md={12}>
              <Card
                title={<span style={{ color: '#0f172a', fontWeight: 800 }}><PictureOutlined style={{ marginRight: 8, color: '#0ea5e9' }} />Signature & Photo Proof</span>}
                size="small"
                style={{ borderRadius: '12px', border: '1px solid #cbd5e1', boxShadow: '0 4px 12px rgba(0,0,0,0.03)', height: '100%' }}
              >
                  <Form.Item label={<span style={{ fontWeight: 600, fontSize: '13px' }}>📝 Receiver Signature / Stamp Photo</span>} required>
                    <Upload
                      maxCount={1}
                      accept="image/*"
                      customRequest={async ({ file, onSuccess, onError }) => {
                        try {
                          await handleUploadFile(file, 'signature_image');
                          onSuccess(null, file);
                        } catch (err) {
                          onError(err);
                        }
                      }}
                      showUploadList={false}
                    >
                      <Button
                        icon={<UploadOutlined />}
                        style={{
                          background: uploadedUrls.signature_image ? 'linear-gradient(135deg,#10b981,#059669)' : 'linear-gradient(135deg,#4f46e5,#3730a3)',
                          color: '#fff',
                          borderColor: 'transparent',
                          fontWeight: 600,
                          borderRadius: '8px',
                          height: '40px',
                          paddingInline: '20px'
                        }}
                      >
                        {uploadedUrls.signature_image ? '✓ Signature Uploaded — Click to Replace' : 'Upload Signature / Stamp'}
                      </Button>
                    </Upload>
                  </Form.Item>

                  {uploadedUrls.signature_image && (
                    <div style={{ marginBottom: '20px', background: 'linear-gradient(135deg,#f0fdf4,#dcfce7)', padding: '16px', borderRadius: '12px', border: '2px solid #86efac' }}>
                      <span style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#166534', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        Signature Preview
                      </span>
                      <Image
                        src={uploadedUrls.signature_image}
                        alt="Receiver Signature"
                        style={{ width: '100%', maxHeight: '200px', objectFit: 'contain', borderRadius: '8px', background: '#fff', display: 'block' }}
                        preview={{ mask: <span style={{ fontSize: '13px', fontWeight: 600 }}>🔍 Zoom</span> }}
                      />
                    </div>
                  )}

                  <Form.Item label={<span style={{ fontWeight: 600, fontSize: '13px' }}>📦 Materials Condition Photo Evidence</span>}>
                    <Upload
                      maxCount={1}
                      accept="image/*"
                      customRequest={async ({ file, onSuccess, onError }) => {
                        try {
                          await handleUploadFile(file, 'materials_photos');
                          onSuccess(null, file);
                        } catch (err) {
                          onError(err);
                        }
                      }}
                      showUploadList={false}
                    >
                      <Button
                        icon={<UploadOutlined />}
                        style={{
                          background: uploadedUrls.materials_photos ? 'linear-gradient(135deg,#10b981,#059669)' : 'linear-gradient(135deg,#0ea5e9,#0284c7)',
                          color: '#fff',
                          borderColor: 'transparent',
                          fontWeight: 600,
                          borderRadius: '8px',
                          height: '40px',
                          paddingInline: '20px'
                        }}
                      >
                        {uploadedUrls.materials_photos ? '✓ Photo Uploaded — Click to Replace' : 'Upload Condition Photo'}
                      </Button>
                    </Upload>
                  </Form.Item>

                  {uploadedUrls.materials_photos && (
                    <div style={{ background: 'linear-gradient(135deg,#f0f9ff,#e0f2fe)', padding: '16px', borderRadius: '12px', border: '2px solid #7dd3fc' }}>
                      <span style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#075985', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        Materials Condition Preview
                      </span>
                      <Image
                        src={uploadedUrls.materials_photos}
                        alt="Materials Condition"
                        style={{ width: '100%', maxHeight: '200px', objectFit: 'contain', borderRadius: '8px', background: '#fff', display: 'block' }}
                        preview={{ mask: <span style={{ fontSize: '13px', fontWeight: 600 }}>🔍 Zoom</span> }}
                      />
                    </div>
                  )}
              </Card>
            </Col>
          </>
        )}

        {/* ── Initial Selection Place Holder ── */}
        {!consignmentData && !packageData && (
          <Col span={24}>
            <Card style={{ borderRadius: '12px', border: '1px dashed #cbd5e1', textAlign: 'center', padding: '60px 40px' }}>
              <BarcodeOutlined style={{ fontSize: '48px', color: '#94a3b8', marginBottom: '16px' }} />
              <Title level={4} style={{ margin: 0, color: '#475569', fontWeight: 700 }}>Awaiting Barcode Scanner Input</Title>
              <Text type="secondary" style={{ display: 'block', marginTop: '8px', fontSize: '14px' }}>
                Please select your operating warehouse location and scan the barcode of a Consignment (delivery confirmation) or a Package to start the verification and acknowledgement pipeline.
              </Text>
            </Card>
          </Col>
        )}
      </Row>
      </Form>
      {activeRow && (
        <AssetCodesTreeModal
          open={modalOpen}
          onCancel={() => {
            setModalOpen(false);
            setActiveRow(null);
          }}
          onSave={handleSaveModalCodes}
          selectedCodes={form.getFieldValue(`serials_rec_${activeRow.id}`) || []}
          rawRows={mockRawRows}
          itemCode={activeRow.material_code || ''}
          itemName={activeRow.material_name || ''}
          itemType={activeRow.material_type || 'asset'}
          targetQty={form.getFieldValue(`qty_acc_${activeRow.id}`) ?? activeRow.quantity_packed}
          autoSelectOnOpen={false}
          serialDetails={activeRow?.serial_details || {}}
        />
      )}
    </div>
  );
};

export default AcknowledgeDelivery;
